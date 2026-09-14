import * as Sentry from "@sentry/node";
import Order, { IOrder } from "../models/Order";
import { redeemCoupon } from "./coupons";
import { createFulfilmentsForOrder } from "./fulfilments";
import type { PaystackTransaction } from "./paystack";
import { toKobo } from "./pricing";
import { commitHold, InsufficientCreditError, spendFromWallet } from "./wallet";

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
  await createFulfilmentsForOrder(order, metadata);
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
