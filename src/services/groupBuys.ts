import crypto from "crypto";
import mongoose from "mongoose";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import Fulfilment from "../models/Fulfilment";
import GroupBuy, { GroupBuyTier } from "../models/GroupBuy";
import Merchant from "../models/Merchant";
import Order, { IOrder } from "../models/Order";
import ProductTemplate from "../models/ProductTemplate";
import { withTransaction } from "./db";
import { formatNaira, toKobo, toNaira } from "./pricing";
import { notifyUser } from "./push";
import { paidItemsValueKobo } from "./refunds";
import { creditWallet } from "./wallet";

export const MAX_GROUP_BUY_HOURS = 7 * 24;
export const MAX_GROUP_PRICES = 5;
const MAX_OPEN_GROUPS_PER_STARTER = 10;
// Savings are the customer's own money, so like refunds the credit effectively never expires.
const SAVINGS_CREDIT_DAYS = 3650;

type GroupOffer = { enabled?: boolean; durationHours?: number; tiers?: { minQuantity: number; price: number }[] } | null | undefined;

type GroupLike = {
  _id: unknown;
  product: unknown;
  starter: unknown;
  code: string;
  title: string;
  imageUrl: string | null;
  basePriceKobo: number;
  tiers: GroupBuyTier[];
  status: string;
  expiresAt: Date;
  participants: { user: unknown; order: unknown; quantity: number; settled?: boolean; savingsKobo?: number }[];
  finalQuantity: number | null;
  finalUnitPriceKobo: number | null;
};

// Checks a merchant's group prices: bigger quantities, lower prices, all below the normal price.
export function groupPricesError(price: number, offer: GroupOffer): string | null {
  if (!offer?.enabled) return null;
  const tiers = offer.tiers ?? [];
  if (tiers.length === 0) return "Add at least one group price.";
  for (const [index, tier] of tiers.entries()) {
    if (toKobo(tier.price) >= toKobo(price)) return "Group prices must be lower than the normal price.";
    const previous = tiers[index - 1];
    if (previous && tier.minQuantity <= previous.minQuantity) return "Each group price needs a bigger quantity than the one before.";
    if (previous && toKobo(tier.price) >= toKobo(previous.price)) return "Bigger groups need lower prices.";
  }
  return null;
}

// The best group price a quantity reaches. Tiers are stored smallest quantity first.
export function tierFor(tiers: GroupBuyTier[], quantity: number) {
  return [...tiers].reverse().find((tier) => quantity >= tier.minQuantity) ?? null;
}

const sumQuantity = (participants: GroupLike["participants"]) => participants.reduce((sum, p) => sum + p.quantity, 0);

export function toGroupBuyResponse(group: GroupLike, viewerId?: string | null) {
  const closed = group.status === "closed";
  const quantity = closed ? group.finalQuantity ?? 0 : sumQuantity(group.participants);
  const tier = tierFor(group.tiers, quantity);
  const next = closed ? null : group.tiers.find((t) => t.minQuantity > quantity) ?? null;
  const mine = viewerId ? group.participants.filter((p) => String(p.user) === String(viewerId)) : [];

  return {
    _id: group._id,
    code: group.code,
    productId: group.product,
    title: group.title,
    imageUrl: group.imageUrl,
    // "closing" covers the few minutes between the deadline and the job that closes the group.
    status: closed ? "closed" : group.expiresAt <= new Date() ? "closing" : "open",
    expiresAt: group.expiresAt,
    normalPrice: toNaira(group.basePriceKobo),
    tiers: group.tiers.map((t) => ({ minQuantity: t.minQuantity, price: toNaira(t.priceKobo) })),
    quantity,
    buyers: new Set(group.participants.map((p) => String(p.user))).size,
    currentPrice: toNaira(closed ? group.finalUnitPriceKobo ?? group.basePriceKobo : tier?.priceKobo ?? group.basePriceKobo),
    nextTier: next ? { minQuantity: next.minQuantity, price: toNaira(next.priceKobo), quantityNeeded: next.minQuantity - quantity } : null,
    startedByYou: viewerId ? String(group.starter) === String(viewerId) : false,
    yourQuantity: sumQuantity(mine),
    yourSavings: toNaira(mine.reduce((sum, p) => sum + (p.savingsKobo ?? 0), 0)),
    shareUrl: env.APP_URL ? `${env.APP_URL.replace(/\/$/, "")}/group-buy/${group.code}` : null,
  };
}

export async function startGroupBuy({ productId, userId }: { productId: string; userId: string }) {
  const product = await ProductTemplate.findById(productId).lean();
  const unavailable = new HttpError(404, "This product is no longer available.");
  if (!product || product.hidden || product.sellerActive === false || product.inStock === false) throw unavailable;
  if (product.merchant) {
    const merchant = await Merchant.findById(product.merchant).select("status").lean();
    if (merchant?.status !== "approved") throw unavailable;
  }

  const offer = product.groupBuy;
  if (!offer?.enabled || !offer.tiers?.length) throw new HttpError(400, "This product doesn't have group prices.");

  const existing = await GroupBuy.findOne({ product: product._id, starter: userId, status: "open", expiresAt: { $gt: new Date() } });
  if (existing) return existing;
  if ((await GroupBuy.countDocuments({ starter: userId, status: "open" })) >= MAX_OPEN_GROUPS_PER_STARTER) {
    throw new HttpError(429, "You have too many open group buys. Wait for one to end before starting another.");
  }

  const hours = Math.min(Math.max(Math.round(offer.durationHours ?? 72), 1), MAX_GROUP_BUY_HOURS);
  for (let attempt = 1; ; attempt++) {
    try {
      return await GroupBuy.create({
        product: product._id,
        merchant: product.merchant ?? null,
        starter: userId,
        code: crypto.randomBytes(6).toString("base64url"),
        title: product.title,
        imageUrl: product.imageUrls?.[0] ?? null,
        basePriceKobo: toKobo(product.price),
        tiers: offer.tiers.map((t) => ({ minQuantity: t.minQuantity, priceKobo: toKobo(t.price) })),
        expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
      });
    } catch (err: any) {
      // A clashing share code; try another.
      if (err?.code !== 11000 || attempt === 3) throw err;
    }
  }
}

// A parcel's payout waits until every group buy its items were bought through has been settled.
async function refreshGroupBuyPending(orderId: unknown) {
  const fulfilments = await Fulfilment.find({ order: orderId, groupBuyPending: true }).select("items.groupBuy").lean();
  for (const fulfilment of fulfilments) {
    const groupIds = [...new Set(fulfilment.items.map((item) => item.groupBuy).filter(Boolean).map(String))];
    const groups = await GroupBuy.find({ _id: { $in: groupIds } }).select("status participants.order participants.settled").lean();
    const waiting = groups.some(
      (group) =>
        group.status === "open" || group.participants.some((p) => String(p.order) === String(orderId) && !p.settled)
    );
    if (!waiting) await Fulfilment.updateOne({ _id: fulfilment._id }, { $set: { groupBuyPending: false } });
  }
}

// Adds a paid order to the group buys its items were bought through. Safe to call more than once.
export async function recordGroupBuyPurchases(order: IOrder, metadata: Record<string, any>) {
  const cart: any[] = Array.isArray(metadata.cart) ? metadata.cart : [];
  const byGroup = new Map<string, { templateId: string; quantity: number }>();
  for (const line of cart) {
    if (!line.groupBuyId || !mongoose.isValidObjectId(line.groupBuyId)) continue;
    const entry = byGroup.get(String(line.groupBuyId)) ?? { templateId: String(line.templateId), quantity: 0 };
    entry.quantity += Number(line.quantity) || 0;
    byGroup.set(String(line.groupBuyId), entry);
  }
  if (byGroup.size === 0) return;

  for (const [groupId, { templateId, quantity }] of byGroup) {
    // Checkout refuses ended groups, so a payment that completes after the deadline still counts until the group is closed.
    await GroupBuy.updateOne(
      { _id: groupId, product: templateId, status: "open", "participants.order": { $ne: order._id } },
      { $push: { participants: { user: order.user, order: order._id, quantity, joinedAt: new Date() } } }
    );
  }
  await refreshGroupBuyPending(order._id);
}

// Units bought through the group that weren't cancelled or returned.
async function keptQuantity(groupId: unknown, orderId: unknown) {
  const fulfilments = await Fulfilment.find({ order: orderId, "items.groupBuy": groupId, status: { $ne: "cancelled" } })
    .select("items")
    .lean();
  return fulfilments
    .flatMap((f) => f.items)
    .filter((item) => String(item.groupBuy) === String(groupId))
    .reduce((sum, item) => sum + item.quantity - (item.returnedQuantity ?? 0), 0);
}

// Credits one buyer's savings and takes them off the seller's parcel, in one transaction.
async function settleParticipant(group: GroupLike, participant: GroupLike["participants"][number]) {
  const savingsPerUnitKobo = Math.max(0, group.basePriceKobo - (group.finalUnitPriceKobo ?? group.basePriceKobo));

  const savingsKobo = await withTransaction(async (session) => {
    const order = await Order.findById(participant.order).session(session).lean();
    const fulfilments = await Fulfilment.find({ order: participant.order, "items.groupBuy": group._id, status: { $ne: "cancelled" } }).session(
      session
    );

    let listSavingsKobo = 0;
    const parcelUpdates: { fulfilment: (typeof fulfilments)[number]; set: Record<string, number>; discountKobo: number }[] = [];
    for (const fulfilment of fulfilments) {
      const set: Record<string, number> = {};
      let discountKobo = fulfilment.groupDiscountKobo ?? 0;
      fulfilment.items.forEach((item, index) => {
        const kept = item.quantity - (item.returnedQuantity ?? 0);
        if (String(item.groupBuy) !== String(group._id) || savingsPerUnitKobo === 0 || kept <= 0) return;
        set[`items.${index}.groupSavingsPerUnitKobo`] = savingsPerUnitKobo;
        discountKobo += savingsPerUnitKobo * kept;
        listSavingsKobo += savingsPerUnitKobo * kept;
      });
      if (Object.keys(set).length > 0) parcelUpdates.push({ fulfilment, set, discountKobo });
    }

    // A coupon on the order already lowered what was paid, so the savings are scaled the same way.
    const credit = paidItemsValueKobo(order, listSavingsKobo);
    const marked = await GroupBuy.updateOne(
      { _id: group._id, participants: { $elemMatch: { order: participant.order, settled: false } } },
      { $set: { "participants.$.settled": true, "participants.$.savingsKobo": credit } },
      { session }
    );
    if (marked.modifiedCount !== 1) return 0;

    for (const { fulfilment, set, discountKobo } of parcelUpdates) {
      const keptItemsKobo = Math.max(0, fulfilment.itemsSubtotalKobo - (fulfilment.refundedItemsKobo ?? 0) - discountKobo);
      const commissionKobo = Math.floor((keptItemsKobo * fulfilment.commissionPercent) / 100);
      await Fulfilment.updateOne(
        { _id: fulfilment._id },
        {
          $set: {
            ...set,
            groupDiscountKobo: discountKobo,
            commissionKobo,
            payoutKobo: fulfilment.merchant ? keptItemsKobo - commissionKobo + fulfilment.deliveryFeeKobo : 0,
          },
        },
        { session }
      );
    }

    if (credit > 0) {
      await creditWallet(
        {
          userId: String(participant.user),
          amountKobo: credit,
          source: "group-buy",
          expiryDays: SAVINGS_CREDIT_DAYS,
          idempotencyKey: `group-buy:${group._id}:${participant.order}`,
          reference: String(participant.order),
          note: `Group buy savings on ${group.title}`,
        },
        session
      );
    }
    return credit;
  });

  await refreshGroupBuyPending(participant.order);

  if (savingsKobo > 0) {
    notifyUser({
      userId: String(participant.user),
      title: "Your group buy savings are in your wallet",
      body: `The group reached ${formatNaira(group.finalUnitPriceKobo ?? group.basePriceKobo)} each for ${group.title}, so ${formatNaira(savingsKobo)} was added to your Impressa wallet.`,
      data: { type: "wallet" },
    });
  }
}

async function settleClosedGroupBuys() {
  const groups = await GroupBuy.find({ status: "closed", participants: { $elemMatch: { settled: false } } })
    .limit(200)
    .lean();
  for (const group of groups) {
    for (const participant of group.participants) {
      if (!participant.settled) await settleParticipant(group, participant);
    }
  }
}

// Closes group buys past their deadline at the best group price they reached, then pays out the savings.
// Safe to run more than once.
export async function closeExpiredGroupBuys(now = new Date()) {
  const expired = await GroupBuy.find({ status: "open", expiresAt: { $lte: now } }).limit(200).lean();

  for (const group of expired) {
    let finalQuantity = 0;
    for (const participant of group.participants) finalQuantity += await keptQuantity(group._id, participant.order);
    const tier = tierFor(group.tiers, finalQuantity);

    // Only closes if no purchase was added while the quantity was being counted; otherwise the next run retries.
    const closed = await GroupBuy.updateOne(
      { _id: group._id, status: "open", participants: { $size: group.participants.length } },
      { $set: { status: "closed", closedAt: now, finalQuantity, finalUnitPriceKobo: tier?.priceKobo ?? group.basePriceKobo } }
    );
    if (closed.modifiedCount !== 1 || tier) continue;

    const buyers = new Set(group.participants.map((p) => String(p.user)));
    for (const userId of buyers) {
      notifyUser({
        userId,
        title: "Your group buy has ended",
        body: `The group for ${group.title} didn't reach a group price, so your order goes ahead at the normal price.`,
        data: { type: "group-buy", code: group.code },
      });
    }
  }

  await settleClosedGroupBuys();
  return expired.length;
}
