import * as Sentry from "@sentry/node";
import { HttpError } from "../middleware/errorHandler";
import Fulfilment, { FulfilmentStatus, IFulfilment } from "../models/Fulfilment";
import Merchant from "../models/Merchant";
import Order, { IOrder, ORDER_STATUSES, OrderStatus, TrackingStatus } from "../models/Order";
import ProductTemplate from "../models/ProductTemplate";
import { getMarketplaceSettings } from "./marketplaceSettings";
import { changeOrderStatus } from "./orderStatus";
import { formatNaira, toKobo, toNaira } from "./pricing";
import { notifyUser, orderNumber } from "./push";
import { paidItemsValueKobo, refundOrderAmount } from "./refunds";
import { daysFromNow } from "./time";

// Delivery stages (from the admin panel or merchant mode) move orders and parcels along.
const STATUS_FOR_TRACKING: Partial<Record<TrackingStatus, "shipped" | "delivered">> = {
  "in-transit": "shipped",
  "ready-for-pickup": "shipped",
  delivered: "delivered",
};

const FULFILMENT_RANK: Record<Exclude<FulfilmentStatus, "cancelled">, number> = { paid: 0, shipped: 1, delivered: 2 };

export type TrackingUpdate = { status?: TrackingStatus | null; code?: string | null };

function trackingUpdateOperators(tracking: TrackingUpdate) {
  const set: Record<string, unknown> = { "tracking.updatedAt": new Date() };
  const unset: Record<string, 1> = {};
  if (tracking.status !== undefined) {
    if (tracking.status) set["tracking.status"] = tracking.status;
    else unset["tracking.status"] = 1;
  }
  if (tracking.code !== undefined) {
    if (tracking.code) set["tracking.code"] = tracking.code;
    else unset["tracking.code"] = 1;
  }
  return { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) };
}

const itemCountText = (fulfilment: IFulfilment) => {
  const count = fulfilment.items.reduce((sum, item) => sum + item.quantity, 0);
  return `${count} item${count === 1 ? "" : "s"}`;
};

// An order's status follows its slowest parcel: it's delivered only when every parcel is.
export async function syncOrderStatus(orderId: string) {
  const fulfilments = await Fulfilment.find({ order: orderId, status: { $ne: "cancelled" } }).select("status").lean();
  if (fulfilments.length === 0) return;

  const slowest = fulfilments.reduce<Exclude<FulfilmentStatus, "cancelled">>((lowest, fulfilment) => {
    const status = fulfilment.status as Exclude<FulfilmentStatus, "cancelled">;
    return FULFILMENT_RANK[status] < FULFILMENT_RANK[lowest] ? status : lowest;
  }, "delivered");

  await changeOrderStatus(orderId, slowest, { notify: false });
}

// Moves a parcel forward (never backwards) and tells the customer.
async function advanceFulfilment(fulfilment: IFulfilment, status: "shipped" | "delivered") {
  const current = fulfilment.status;
  if (current === "cancelled" || FULFILMENT_RANK[status] <= FULFILMENT_RANK[current]) return fulfilment;

  const now = new Date();
  const changed = await Fulfilment.findOneAndUpdate(
    { _id: fulfilment._id, status: current },
    {
      $set: { status, ...(status === "delivered" ? { deliveredAt: now } : {}) },
      $push: { statusHistory: { status, at: now } },
    },
    { new: true }
  );
  if (!changed) return Fulfilment.findById(fulfilment._id);

  notifyUser({
    userId: String(changed.user),
    title: status === "shipped" ? "Your items are on their way" : "Your items have been delivered",
    body: `${changed.sellerName} ${status === "shipped" ? "shipped" : "delivered"} ${itemCountText(changed)} from order #${orderNumber(String(changed.order))}.`,
    data: { type: "order", orderId: String(changed.order) },
  });

  await syncOrderStatus(String(changed.order));
  return changed;
}

// Saves a parcel's delivery stage and tracking code. Pass { merchant } to limit it to that merchant's parcels.
export async function updateFulfilmentTracking(fulfilmentId: string, tracking: TrackingUpdate, scope: { merchant?: unknown } = {}) {
  const fulfilment = await Fulfilment.findOneAndUpdate(
    { _id: fulfilmentId, status: { $ne: "cancelled" }, ...scope },
    trackingUpdateOperators(tracking),
    { new: true }
  );
  if (!fulfilment) return null;

  const next = tracking.status ? STATUS_FOR_TRACKING[tracking.status] : undefined;
  return next ? advanceFulfilment(fulfilment, next) : fulfilment;
}

// Order-level delivery stage from the admin panel. For marketplace orders it applies to every parcel.
export async function updateTracking(orderId: string, tracking: TrackingUpdate) {
  const order = await Order.findByIdAndUpdate(orderId, trackingUpdateOperators(tracking), { new: true });
  if (!order) return null;

  const fulfilments = await Fulfilment.find({ order: orderId, status: { $ne: "cancelled" } }).select("_id").lean();
  if (fulfilments.length > 0) {
    for (const fulfilment of fulfilments) await updateFulfilmentTracking(String(fulfilment._id), tracking);
    return Order.findById(orderId);
  }

  const next = tracking.status ? STATUS_FOR_TRACKING[tracking.status] : undefined;
  // Never move an order backwards, e.g. choosing "in transit" after it was delivered.
  if (next && ORDER_STATUSES.indexOf(next) > ORDER_STATUSES.indexOf(order.status)) {
    return changeOrderStatus(orderId, next);
  }
  return order;
}

// Sets an order's status from the admin panel. Marketplace orders only move forward, parcel by parcel.
export async function setOrderStatus(orderId: string, status: OrderStatus) {
  const fulfilments = await Fulfilment.find({ order: orderId, status: { $ne: "cancelled" } });
  if (fulfilments.length === 0) return changeOrderStatus(orderId, status);

  if (status === "shipped" || status === "delivered") {
    for (const fulfilment of fulfilments) await advanceFulfilment(fulfilment, status);
  } else if (fulfilments.some((fulfilment) => fulfilment.status !== "paid")) {
    throw new HttpError(409, "Marketplace orders can't be moved back. Update each seller's parcel instead.");
  }
  return Order.findById(orderId);
}

async function notifyMerchantsOfNewOrders(fulfilments: IFulfilment[]) {
  const merchantFulfilments = fulfilments.filter((fulfilment) => fulfilment.merchant);
  if (merchantFulfilments.length === 0) return;

  const merchants = new Map(
    (await Merchant.find({ _id: { $in: merchantFulfilments.map((f) => f.merchant) } }).select("user").lean()).map((m) => [
      String(m._id),
      m,
    ])
  );
  for (const fulfilment of merchantFulfilments) {
    const merchant = merchants.get(String(fulfilment.merchant));
    if (!merchant) continue;
    notifyUser({
      userId: String(merchant.user),
      title: "New order to ship",
      body: `Order #${orderNumber(String(fulfilment.order))}: ${itemCountText(fulfilment)}, ${formatNaira(fulfilment.itemsSubtotalKobo)}.`,
      data: { type: "merchant-order", fulfilmentId: String(fulfilment._id) },
    });
  }
}

// Takes each parcel's stock once. The parcel is claimed first, so verify polling and webhook retries can't take it twice.
async function reserveStock(orderId: unknown) {
  const pending = await Fulfilment.find({ order: orderId, stockReserved: false });

  for (const fulfilment of pending) {
    const claimed = await Fulfilment.updateOne({ _id: fulfilment._id, stockReserved: false }, { $set: { stockReserved: true } });
    if (claimed.modifiedCount !== 1) continue;

    const oversold: string[] = [];
    for (const [index, item] of fulfilment.items.entries()) {
      if (!item.templateId) continue;
      const taken = await ProductTemplate.updateOne(
        { _id: item.templateId, stockQuantity: { $gte: item.quantity } },
        { $inc: { stockQuantity: -item.quantity } }
      );
      if (taken.modifiedCount === 1) continue;

      // Untracked stock (null) is fine; otherwise another customer bought the last units first.
      const product = await ProductTemplate.findById(item.templateId).select("stockQuantity").lean();
      if (product && typeof product.stockQuantity === "number") oversold.push(`items.${index}.oversold`);
    }

    if (oversold.length > 0) {
      await Fulfilment.updateOne(
        { _id: fulfilment._id },
        { $set: { needsAttention: true, ...Object.fromEntries(oversold.map((path) => [path, true])) } }
      );
      const message = `Fulfilment ${fulfilment._id} was paid for but some items were out of stock`;
      console.error(message);
      Sentry.captureMessage(message, "warning");
    }
  }
}

// Splits a paid order into one fulfilment per seller, fixing commission and payout at today's rates.
// Safe to call more than once.
export async function createFulfilmentsForOrder(order: IOrder, metadata: Record<string, any>) {
  const sellers: any[] = Array.isArray(metadata.sellers) ? metadata.sellers : [];
  // Checkouts from before the marketplace have no seller breakdown and are handled at order level.
  if (sellers.length === 0) return;

  if (!(await Fulfilment.exists({ order: order._id }))) {
    const settings = await getMarketplaceSettings();
    const merchantIds = sellers.map((seller) => seller.merchantId).filter(Boolean);
    const merchants = new Map(
      (await Merchant.find({ _id: { $in: merchantIds } }).select("commissionPercent").lean()).map((m) => [String(m._id), m])
    );
    const cart: any[] = Array.isArray(metadata.cart) ? metadata.cart : [];
    const now = new Date();

    const docs = sellers.map((seller) => {
      const merchantId: string | null = seller.merchantId ?? null;
      const lines = cart.filter((line) => (line.merchantId ?? null) === merchantId);
      const itemsSubtotalKobo = lines.reduce((sum, line) => sum + toKobo(Number(line.unitPrice)) * Number(line.quantity), 0);
      const commissionPercent = merchantId
        ? merchants.get(merchantId)?.commissionPercent ?? settings.defaultCommissionPercent
        : 0;
      const commissionKobo = Math.floor((itemsSubtotalKobo * commissionPercent) / 100);
      const deliveryFeeKobo = toKobo(Number(seller.deliveryFee) || 0);

      return {
        order: order._id,
        user: order.user,
        merchant: merchantId,
        sellerName: seller.name,
        items: lines.map((line) => ({
          templateId: line.templateId ?? null,
          title: line.title,
          quantity: Number(line.quantity),
          unitPriceKobo: toKobo(Number(line.unitPrice)),
          size: line.options?.size ?? undefined,
          color: line.options?.color ?? undefined,
          imageUrl: line.imageUrl ?? undefined,
          groupBuy: line.groupBuyId ?? null,
        })),
        groupBuyPending: lines.some((line) => line.groupBuyId),
        itemsSubtotalKobo,
        deliveryFeeKobo,
        commissionPercent,
        commissionKobo,
        // Merchants ship their own parcels, so they receive their delivery fee too.
        payoutKobo: merchantId ? itemsSubtotalKobo - commissionKobo + deliveryFeeKobo : 0,
        status: "paid",
        statusHistory: [{ status: "paid", at: now }],
        payout: { status: merchantId ? "pending" : "not-applicable" },
      };
    });

    try {
      const created = await Fulfilment.insertMany(docs);
      await notifyMerchantsOfNewOrders(created as unknown as IFulfilment[]);
    } catch (err: any) {
      // Verify and the webhook can arrive together; the unique index lets only one of them create the fulfilments.
      if (err?.code !== 11000) throw err;
    }
  }

  await reserveStock(order._id);
}

// Cancels a parcel that hasn't shipped: refunds its items and delivery fee (to the card where possible,
// since the customer didn't choose this) and puts the stock back. Returns null if it can't be cancelled.
export async function cancelFulfilment(fulfilmentId: string, { reason, scope = {} }: { reason: string; scope?: { merchant?: unknown } }) {
  const now = new Date();
  const fulfilment = await Fulfilment.findOneAndUpdate(
    { _id: fulfilmentId, status: "paid", ...scope },
    {
      $set: { status: "cancelled", cancelReason: reason, cancelledAt: now, "payout.status": "not-applicable" },
      $push: { statusHistory: { status: "cancelled", at: now } },
    },
    { new: true }
  );
  if (!fulfilment) return null;

  const order = await Order.findById(fulfilment.order).lean();
  // Group buy savings already credited to the wallet aren't refunded again.
  const refundKobo =
    paidItemsValueKobo(order, fulfilment.itemsSubtotalKobo - (fulfilment.groupDiscountKobo ?? 0)) + fulfilment.deliveryFeeKobo;
  const refund = await refundOrderAmount({
    orderId: String(fulfilment.order),
    amountKobo: refundKobo,
    destination: "card",
    idempotencyKey: `cancel:${fulfilment._id}`,
    note: `Cancelled by seller: ${reason}`,
  });

  if (fulfilment.stockReserved) {
    for (const item of fulfilment.items) {
      if (!item.templateId || item.oversold) continue;
      await ProductTemplate.updateOne(
        { _id: item.templateId, stockQuantity: { $ne: null } },
        { $inc: { stockQuantity: item.quantity } }
      );
    }
  }

  notifyUser({
    userId: String(fulfilment.user),
    title: "Part of your order was cancelled",
    body: `${fulfilment.sellerName} couldn't send ${itemCountText(fulfilment)} from order #${orderNumber(String(fulfilment.order))}. ${formatNaira(refundKobo)} is being refunded${refund.walletKobo > 0 && refund.cardKobo === 0 ? " to your wallet" : ""}.`,
    data: { type: "order", orderId: String(fulfilment.order) },
  });

  await syncOrderStatus(String(fulfilment.order));
  return fulfilment;
}

export function toCustomerFulfilment(fulfilment: any, returnWindowDays: number) {
  return {
    _id: fulfilment._id,
    merchant: fulfilment.merchant,
    sellerName: fulfilment.sellerName,
    status: fulfilment.status,
    statusHistory: fulfilment.statusHistory ?? [],
    tracking: fulfilment.tracking ?? null,
    deliveryFee: toNaira(fulfilment.deliveryFeeKobo),
    itemsSubtotal: toNaira(fulfilment.itemsSubtotalKobo),
    items: (fulfilment.items ?? []).map((item: any) => ({
      templateId: item.templateId,
      title: item.title,
      quantity: item.quantity,
      unitPrice: toNaira(item.unitPriceKobo),
      size: item.size ?? null,
      color: item.color ?? null,
      imageUrl: item.imageUrl ?? null,
      returnedQuantity: item.returnedQuantity ?? 0,
    })),
    deliveredAt: fulfilment.deliveredAt ?? null,
    returnWindowEndsAt: fulfilment.deliveredAt ? daysFromNow(returnWindowDays, new Date(fulfilment.deliveredAt)) : null,
  };
}

export function toAdminFulfilment(fulfilment: any, returnWindowDays: number) {
  return {
    ...toCustomerFulfilment(fulfilment, returnWindowDays),
    commissionPercent: fulfilment.commissionPercent,
    commission: toNaira(fulfilment.commissionKobo),
    payout: toNaira(fulfilment.payoutKobo),
    payoutStatus: fulfilment.payout?.status,
    needsAttention: fulfilment.needsAttention,
    oversoldItems: (fulfilment.items ?? []).filter((item: any) => item.oversold).map((item: any) => item.title),
  };
}

// Adds each order's parcels to API responses.
export async function withFulfilments<T extends { _id: unknown }>(orders: T[], audience: "customer" | "admin") {
  if (orders.length === 0) return orders;
  const [fulfilments, settings] = await Promise.all([
    Fulfilment.find({ order: { $in: orders.map((order) => order._id) } }).sort({ createdAt: 1 }).lean(),
    getMarketplaceSettings(),
  ]);

  const toResponse = audience === "admin" ? toAdminFulfilment : toCustomerFulfilment;
  const byOrder = new Map<string, any[]>();
  for (const fulfilment of fulfilments) {
    const list = byOrder.get(String(fulfilment.order)) ?? [];
    list.push(toResponse(fulfilment, settings.returnWindowDays));
    byOrder.set(String(fulfilment.order), list);
  }
  return orders.map((order) => ({ ...order, fulfilments: byOrder.get(String(order._id)) ?? [] }));
}
