import mongoose, { ClientSession } from "mongoose";
import Order from "../models/Order";
import WalletHold from "../models/WalletHold";
import WalletLot, { CreditSource } from "../models/WalletLot";
import WalletTransaction, { LotAllocation } from "../models/WalletTransaction";
import { daysFromNow } from "./time";

// How long checkout keeps wallet credit set aside while the customer pays the rest on Paystack.
const HOLD_MINUTES = 120;

export class InsufficientCreditError extends Error {
  constructor() {
    super("Not enough wallet credit.");
    this.name = "InsufficientCreditError";
  }
}

const isDuplicateIdempotencyKey = (err: any) => err?.code === 11000 && Boolean(err?.keyPattern?.idempotencyKey);

// Runs fn in a new transaction, or inside the caller's transaction when a session is passed.
async function inTransaction<T>(session: ClientSession | undefined, fn: (session: ClientSession) => Promise<T>) {
  if (session) return fn(session);
  let result!: T;
  await mongoose.connection.transaction(async (transactionSession) => {
    result = await fn(transactionSession);
  });
  return result;
}

const liveLotFilter = (userId: string) => ({
  user: new mongoose.Types.ObjectId(userId),
  remainingKobo: { $gt: 0 },
  expiresAt: { $gt: new Date() },
});

export async function getAvailableCreditKobo(userId: string, session?: ClientSession) {
  const [row] = await WalletLot.aggregate<{ total: number }>([
    { $match: liveLotFilter(userId) },
    { $group: { _id: null, total: { $sum: "$remainingKobo" } } },
  ]).session(session ?? null);
  return row?.total ?? 0;
}

type CreditInput = {
  userId: string;
  amountKobo: number;
  source: CreditSource;
  expiryDays: number;
  idempotencyKey: string;
  reference?: string;
  actorId?: string;
  note?: string;
};

// Adds credit as its own lot with an expiry date. Returns false if the idempotency key was already used.
export async function creditWallet(input: CreditInput, session?: ClientSession) {
  if (!Number.isInteger(input.amountKobo) || input.amountKobo <= 0) {
    throw new Error("Credit must be a positive whole number of kobo");
  }

  try {
    await inTransaction(session, async (s) => {
      const lotId = new mongoose.Types.ObjectId();
      await WalletTransaction.create(
        [
          {
            user: input.userId,
            kind: "credit",
            amountKobo: input.amountKobo,
            source: input.source,
            reference: input.reference,
            idempotencyKey: input.idempotencyKey,
            allocations: [{ lot: lotId, amountKobo: input.amountKobo }],
            actor: input.actorId,
            note: input.note,
          },
        ],
        { session: s }
      );
      await WalletLot.create(
        [
          {
            _id: lotId,
            user: input.userId,
            source: input.source,
            amountKobo: input.amountKobo,
            remainingKobo: input.amountKobo,
            expiresAt: daysFromNow(input.expiryDays),
            reference: input.reference,
          },
        ],
        { session: s }
      );
    });
    return true;
  } catch (err) {
    if (isDuplicateIdempotencyKey(err)) return false;
    throw err;
  }
}

// Draws credit from the lots that expire soonest. Must run inside a transaction.
async function takeFromLots(userId: string, amountKobo: number, session: ClientSession) {
  const lots = await WalletLot.find(liveLotFilter(userId)).sort({ expiresAt: 1, _id: 1 }).session(session);

  const allocations: LotAllocation[] = [];
  let needed = amountKobo;
  for (const lot of lots) {
    if (needed === 0) break;
    const take = Math.min(lot.remainingKobo, needed);
    const result = await WalletLot.updateOne(
      { _id: lot._id, remainingKobo: { $gte: take } },
      { $inc: { remainingKobo: -take } },
      { session }
    );
    if (result.modifiedCount !== 1) throw new InsufficientCreditError();
    allocations.push({ lot: lot._id as mongoose.Types.ObjectId, amountKobo: take });
    needed -= take;
  }

  if (needed > 0) throw new InsufficientCreditError();
  return allocations;
}

type SpendInput = {
  userId: string;
  amountKobo: number;
  source: string;
  idempotencyKey: string;
  reference?: string;
  actorId?: string;
  note?: string;
};

// Removes credit straight away. Throws InsufficientCreditError; returns false if the key was already used.
export async function spendFromWallet(input: SpendInput) {
  try {
    await inTransaction(undefined, async (session) => {
      const allocations = await takeFromLots(input.userId, input.amountKobo, session);
      await WalletTransaction.create(
        [
          {
            user: input.userId,
            kind: "debit",
            amountKobo: -input.amountKobo,
            source: input.source,
            reference: input.reference,
            idempotencyKey: input.idempotencyKey,
            allocations,
            actor: input.actorId,
            note: input.note,
          },
        ],
        { session }
      );
    });
    return true;
  } catch (err) {
    if (isDuplicateIdempotencyKey(err)) return false;
    throw err;
  }
}

// Sets credit aside for a checkout. Throws InsufficientCreditError if the balance changed since the quote.
export async function holdWalletCredit({ userId, amountKobo, reference }: { userId: string; amountKobo: number; reference: string }) {
  await inTransaction(undefined, async (session) => {
    const allocations = await takeFromLots(userId, amountKobo, session);
    await WalletHold.create(
      [
        {
          user: userId,
          reference,
          amountKobo,
          allocations,
          status: "held",
          expiresAt: new Date(Date.now() + HOLD_MINUTES * 60_000),
        },
      ],
      { session }
    );
    await WalletTransaction.create(
      [
        {
          user: userId,
          kind: "hold",
          amountKobo: -amountKobo,
          source: "checkout",
          reference,
          idempotencyKey: `hold:${reference}`,
          allocations,
        },
      ],
      { session }
    );
  });
}

// Keeps held credit spent once the order is paid. The hold already took it out of the balance.
export async function commitHold(reference: string): Promise<"committed" | "released" | "missing"> {
  const committed = await WalletHold.findOneAndUpdate({ reference, status: "held" }, { $set: { status: "committed" } });
  if (committed) return "committed";

  const hold = await WalletHold.findOne({ reference }).lean();
  if (!hold) return "missing";
  return hold.status === "released" ? "released" : "committed";
}

// Returns held credit when checkout doesn't complete. Returns false if there was nothing to release.
export async function releaseHold(reference: string) {
  return inTransaction(undefined, async (session) => {
    const hold = await WalletHold.findOneAndUpdate(
      { reference, status: "held" },
      { $set: { status: "released" } },
      { new: true, session }
    );
    if (!hold) return false;

    // Credit returned to a lot that has since expired is picked up by the next expiry run.
    for (const allocation of hold.allocations) {
      await WalletLot.updateOne({ _id: allocation.lot }, { $inc: { remainingKobo: allocation.amountKobo } }, { session });
    }
    await WalletTransaction.create(
      [
        {
          user: hold.user,
          kind: "release",
          amountKobo: hold.amountKobo,
          source: "checkout",
          reference,
          idempotencyKey: `release:${reference}`,
          allocations: hold.allocations,
        },
      ],
      { session }
    );
    return true;
  });
}

// Settles holds that timed out: spent if an order was created for the payment, returned otherwise.
export async function settleExpiredHolds(now = new Date()) {
  const holds = await WalletHold.find({ status: "held", expiresAt: { $lte: now } }).limit(500).lean();
  for (const hold of holds) {
    if (await Order.exists({ paymentRef: hold.reference })) await commitHold(hold.reference);
    else await releaseHold(hold.reference);
  }
  return holds.length;
}

// Zeroes lots past their expiry date and records each expiry in the ledger.
export async function expireLots(now = new Date()) {
  const lots = await WalletLot.find({ remainingKobo: { $gt: 0 }, expiresAt: { $lte: now } }).limit(500).lean();

  let expired = 0;
  for (const lot of lots) {
    const didExpire = await inTransaction(undefined, async (session) => {
      const before = await WalletLot.findOneAndUpdate(
        { _id: lot._id, remainingKobo: { $gt: 0 }, expiresAt: { $lte: now } },
        { $set: { remainingKobo: 0 } },
        { session }
      );
      if (!before) return false;
      await WalletTransaction.create(
        [
          {
            user: before.user,
            kind: "expiry",
            amountKobo: -before.remainingKobo,
            source: "expiry",
            reference: String(before._id),
            allocations: [{ lot: before._id, amountKobo: before.remainingKobo }],
          },
        ],
        { session }
      );
      return true;
    });
    if (didExpire) expired++;
  }
  return expired;
}

// For every customer, the ledger total must equal the credit left in their lots. Returns any that don't match.
export async function findWalletMismatches() {
  const [ledger, lots] = await Promise.all([
    WalletTransaction.aggregate<{ _id: mongoose.Types.ObjectId; total: number }>([
      { $group: { _id: "$user", total: { $sum: "$amountKobo" } } },
    ]),
    WalletLot.aggregate<{ _id: mongoose.Types.ObjectId; total: number }>([
      { $group: { _id: "$user", total: { $sum: "$remainingKobo" } } },
    ]),
  ]);

  const ledgerTotals = new Map(ledger.map((row) => [String(row._id), row.total]));
  const lotTotals = new Map(lots.map((row) => [String(row._id), row.total]));
  const userIds = new Set([...ledgerTotals.keys(), ...lotTotals.keys()]);

  return [...userIds].flatMap((userId) => {
    const ledgerKobo = ledgerTotals.get(userId) ?? 0;
    const lotsKobo = lotTotals.get(userId) ?? 0;
    return ledgerKobo === lotsKobo ? [] : [{ userId, ledgerKobo, lotsKobo }];
  });
}

export async function getWalletSummary(userId: string) {
  const now = new Date();
  const soon = daysFromNow(14, now);
  const [lots, transactions] = await Promise.all([
    WalletLot.find(liveLotFilter(userId)).sort({ expiresAt: 1 }).lean(),
    WalletTransaction.find({ user: userId }).sort({ createdAt: -1 }).limit(30).lean(),
  ]);

  const balanceKobo = lots.reduce((sum, lot) => sum + lot.remainingKobo, 0);
  const expiring = lots.filter((lot) => lot.expiresAt <= soon);

  return {
    balanceKobo,
    expiringSoon:
      expiring.length > 0
        ? { amountKobo: expiring.reduce((sum, lot) => sum + lot.remainingKobo, 0), expiresAt: expiring[0].expiresAt }
        : null,
    transactions,
  };
}
