import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/app";
import WalletHold from "../src/models/WalletHold";
import WalletLot from "../src/models/WalletLot";
import WalletTransaction from "../src/models/WalletTransaction";
import {
  commitHold,
  creditWallet,
  expireLots,
  findWalletMismatches,
  getAvailableCreditKobo,
  holdWalletCredit,
  InsufficientCreditError,
  releaseHold,
  settleExpiredHolds,
  spendFromWallet,
} from "../src/services/wallet";
import { clearDatabase, createOrder, createUser, startDatabase, stopDatabase } from "./helpers";

void app; // importing the app registers every model

let keyCounter = 0;
const credit = (userId: string, amountKobo: number, expiryDays = 90) =>
  creditWallet({ userId, amountKobo, source: "adjustment", expiryDays, idempotencyKey: `test-credit-${++keyCounter}` });

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(clearDatabase);

describe("wallet credit", () => {
  it("spends the credit that expires soonest first", async () => {
    const { user } = await createUser();
    await credit(user.id, 50_000, 90);
    await credit(user.id, 30_000, 10);

    await spendFromWallet({ userId: user.id, amountKobo: 40_000, source: "adjustment", idempotencyKey: "spend-1" });

    const lots = await WalletLot.find({ user: user._id }).sort({ expiresAt: 1 }).lean();
    expect(lots.map((lot) => lot.remainingKobo)).toEqual([0, 40_000]);
    expect(await getAvailableCreditKobo(user.id)).toBe(40_000);
  });

  it("stops counting expired credit and records the expiry in the ledger", async () => {
    const { user } = await createUser();
    await credit(user.id, 25_000);
    await WalletLot.updateMany({ user: user._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await getAvailableCreditKobo(user.id)).toBe(0);
    expect(await expireLots()).toBe(1);
    expect(await expireLots()).toBe(0);

    const kinds = (await WalletTransaction.find({ user: user._id }).lean()).map((entry) => entry.kind).sort();
    expect(kinds).toEqual(["credit", "expiry"]);
    expect(await findWalletMismatches()).toEqual([]);
  });

  it("never lets two checkouts spend the same credit", async () => {
    const { user } = await createUser();
    await credit(user.id, 100_000);

    const results = await Promise.allSettled([
      holdWalletCredit({ userId: user.id, amountKobo: 80_000, reference: "ref_first" }),
      holdWalletCredit({ userId: user.id, amountKobo: 80_000, reference: "ref_second" }),
    ]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(InsufficientCreditError);
    expect(await getAvailableCreditKobo(user.id)).toBe(20_000);
    expect(await findWalletMismatches()).toEqual([]);
  });

  it("returns held credit when a checkout doesn't finish", async () => {
    const { user } = await createUser();
    await credit(user.id, 100_000);
    await holdWalletCredit({ userId: user.id, amountKobo: 30_000, reference: "ref_abandoned" });
    expect(await getAvailableCreditKobo(user.id)).toBe(70_000);

    expect(await releaseHold("ref_abandoned")).toBe(true);
    expect(await releaseHold("ref_abandoned")).toBe(false);
    expect(await getAvailableCreditKobo(user.id)).toBe(100_000);
    expect(await findWalletMismatches()).toEqual([]);
  });

  it("keeps held credit spent once the order is paid", async () => {
    const { user } = await createUser();
    await credit(user.id, 100_000);
    await holdWalletCredit({ userId: user.id, amountKobo: 30_000, reference: "ref_paid" });

    expect(await commitHold("ref_paid")).toBe("committed");
    expect(await releaseHold("ref_paid")).toBe(false);
    expect(await getAvailableCreditKobo(user.id)).toBe(70_000);
  });

  it("settles timed-out holds: spent if the order exists, returned if not", async () => {
    const { user } = await createUser();
    await credit(user.id, 100_000);
    await holdWalletCredit({ userId: user.id, amountKobo: 20_000, reference: "ref_order_exists" });
    await holdWalletCredit({ userId: user.id, amountKobo: 30_000, reference: "ref_no_order" });
    await createOrder(user._id, { paymentRef: "ref_order_exists" });
    await WalletHold.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await settleExpiredHolds()).toBe(2);

    const holds = await WalletHold.find().lean();
    expect(Object.fromEntries(holds.map((hold) => [hold.reference, hold.status]))).toEqual({
      ref_order_exists: "committed",
      ref_no_order: "released",
    });
    expect(await getAvailableCreditKobo(user.id)).toBe(80_000);
  });

  it("ignores a repeated credit with the same idempotency key", async () => {
    const { user } = await createUser();
    const once = { userId: user.id, amountKobo: 10_000, source: "cashback" as const, expiryDays: 90, idempotencyKey: "cashback:order-1" };

    expect(await creditWallet(once)).toBe(true);
    expect(await creditWallet(once)).toBe(false);
    expect(await getAvailableCreditKobo(user.id)).toBe(10_000);
  });
});
