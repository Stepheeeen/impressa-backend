import * as Sentry from "@sentry/node";
import Order, { IOrder, ORDER_STATUSES, OrderStatus, TrackingStatus } from "../models/Order";
import { redeemCoupon } from "./coupons";
import type { PaystackTransaction } from "./paystack";
import { toKobo } from "./pricing";
import { notifyOrderStatus } from "./push";
import { awardCashback } from "./rewards";
import { commitHold, InsufficientCreditError, spendFromWallet } from "./wallet";

// Updates an order's status, records it in the history and notifies the customer. Returns null if the order doesn't exist.
export async function changeOrderStatus(orderId: string, status: OrderStatus) {
  // Only matches when the status actually changes, so repeated clicks don't add history or send duplicate notifications.
  const changed = await Order.findOneAndUpdate(
    { _id: orderId, status: { $ne: status } },
    { $set: { status }, $push: { statusHistory: { status, at: new Date() } } },
    { new: true }
  );

  if (!changed) return Order.findById(orderId);

  notifyOrderStatus({ userId: String(changed.user), orderId: String(changed._id), status });

  if (status === "delivered") {
    // Cashback must never block the status update; a failure is logged for follow-up.
    await awardCashback(String(changed._id)).catch((err) => {
      console.error(`Cashback for order ${changed._id} failed:`, err);
      Sentry.captureException(err);
    });
  }

  return changed;
}

// The admin panel only sets delivery stages, so these stages move the order along (and notify the customer).
const ORDER_STATUS_FOR_TRACKING: Partial<Record<TrackingStatus, OrderStatus>> = {
  "in-transit": "shipped",
  "ready-for-pickup": "shipped",
  delivered: "delivered",
};

type TrackingUpdate = { status?: TrackingStatus | null; code?: string | null };

// Saves the delivery stage and tracking code. Empty values clear them. Returns null if the order doesn't exist.
export async function updateTracking(orderId: string, tracking: TrackingUpdate) {
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

  const order = await Order.findByIdAndUpdate(
    orderId,
    { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
    { new: true }
  );
  if (!order) return null;

  const nextStatus = tracking.status ? ORDER_STATUS_FOR_TRACKING[tracking.status] : undefined;
  // Never move an order backwards, e.g. choosing "in transit" after it was delivered.
  if (nextStatus && ORDER_STATUSES.indexOf(nextStatus) > ORDER_STATUSES.indexOf(order.status)) {
    return changeOrderStatus(orderId, nextStatus);
  }
  return order;
}

export class PaymentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentMismatchError";
  }
}

export function parseMetadata(metadata: unknown): Record<string, any> {
  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata);
    } catch {
      return {};
    }
  }
  return metadata && typeof metadata === "object" ? (metadata as Record<string, any>) : {};
}

// metadata.totalAmount is the amount charged to the card (the order total minus any wallet credit).
function findMismatch(tx: PaystackTransaction, metadata: Record<string, any>): string | null {
  const expectedKobo = Math.round(Number(metadata.totalAmount) * 100);
  if (!metadata.userId) return "no userId in metadata";
  if (!Array.isArray(metadata.cart) || metadata.cart.length === 0) return "no cart in metadata";
  if (tx.currency !== "NGN") return `currency is ${tx.currency}`;
  if (!(expectedKobo > 0) || tx.amount !== expectedKobo) {
    return `paid ${tx.amount} kobo but the order total is ${expectedKobo} kobo`;
  }
  return null;
}

// Creates the order for a successful Paystack payment, or returns the existing one. Safe to call more than once.
export async function createOrderFromPayment(tx: PaystackTransaction) {
  const metadata = parseMetadata(tx.metadata);

  const mismatch = findMismatch(tx, metadata);
  if (mismatch) {
    const message = `Payment ${tx.reference} was not turned into an order: ${mismatch}`;
    console.error(message);
    Sentry.captureMessage(message, "error");
    throw new PaymentMismatchError(message);
  }

  return createOrder({ reference: tx.reference, email: tx.customer?.email, metadata, cardPaidKobo: tx.amount });
}

// A checkout paid entirely with wallet credit: nothing was charged to a card.
export function createOrderFromWallet(input: { reference: string; email: string; metadata: Record<string, any> }) {
  return createOrder({ ...input, cardPaidKobo: 0 });
}

async function createOrder({
  reference,
  email,
  metadata,
  cardPaidKobo,
}: {
  reference: string;
  email?: string;
  metadata: Record<string, any>;
  cardPaidKobo: number;
}) {
  const cart: any[] = metadata.cart;
  // Checkouts from before coupons and wallet credit only know the card amount.
  const hasPricing = metadata.orderTotal !== undefined;

  let order = await Order.findOne({ paymentRef: reference });
  if (!order) {
    try {
      order = await Order.create({
        user: metadata.userId,
        itemType: metadata.itemType || cart[0]?.title || "general-item",
        quantity: Number(metadata.quantity) || cart.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0),
        totalAmount: hasPricing ? Number(metadata.orderTotal) : cardPaidKobo / 100,
        deliveryAddress: {
          address: metadata.address,
          state: metadata.state,
          country: metadata.country || "Nigeria",
          phone: metadata.phone,
        },
        paymentRef: reference,
        status: "paid",
        statusHistory: [{ status: "paid", at: new Date() }],
        email,
        items: cart,
        itemNames: cart.map((item, index) => item.title || item.name || `item-${index + 1}`),
        instructions: "Delivery will take 3–7 days. Ensure your WhatsApp and email are active.",
        ...(hasPricing
          ? {
              pricing: {
                subtotalKobo: toKobo(Number(metadata.subtotal)),
                deliveryFeeKobo: toKobo(Number(metadata.deliveryFee)),
                discountKobo: toKobo(Number(metadata.discount) || 0),
                couponCode: metadata.couponCode || undefined,
                walletAppliedKobo: toKobo(Number(metadata.walletApplied) || 0),
                cardPaidKobo,
              },
            }
          : {}),
      });
    } catch (err: any) {
      // Verify and the webhook can arrive together; the unique index lets only one of them create the order.
      if (err?.code !== 11000) throw err;
      order = await Order.findOne({ paymentRef: reference });
      if (!order) throw err;
    }
  }

  await settleOrderPayment(order);
  return order;
}

// Spends the held wallet credit and records the coupon for a paid order. Safe to repeat.
async function settleOrderPayment(order: IOrder) {
  const walletAppliedKobo = order.pricing?.walletAppliedKobo ?? 0;

  if (walletAppliedKobo > 0 && (await commitHold(order.paymentRef)) !== "committed") {
    // The hold timed out before payment finished, so take the credit now if the customer still has it.
    try {
      await spendFromWallet({
        userId: String(order.user),
        amountKobo: walletAppliedKobo,
        source: "checkout",
        reference: order.paymentRef,
        idempotencyKey: `late-checkout:${order.paymentRef}`,
      });
    } catch (err) {
      if (!(err instanceof InsufficientCreditError)) throw err;
      await Order.updateOne({ _id: order._id }, { $set: { walletShortfallKobo: walletAppliedKobo } });
      const message = `Order ${order._id} was paid, but ₦${walletAppliedKobo / 100} of wallet credit was no longer available`;
      console.error(message);
      Sentry.captureMessage(message, "warning");
    }
  }

  if (order.pricing?.couponCode) {
    await redeemCoupon({
      couponCode: order.pricing.couponCode,
      userId: String(order.user),
      orderId: String(order._id),
      reference: order.paymentRef,
      discountKobo: order.pricing.discountKobo,
    });
  }
}
