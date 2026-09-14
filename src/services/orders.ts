import * as Sentry from "@sentry/node";
import Order from "../models/Order";
import type { PaystackTransaction } from "./paystack";

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

  const existing = await Order.findOne({ paymentRef: tx.reference });
  if (existing) return existing;

  const cart: any[] = metadata.cart;

  try {
    return await Order.create({
      user: metadata.userId,
      itemType: metadata.itemType || cart[0]?.title || "general-item",
      quantity: Number(metadata.quantity) || cart.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0),
      totalAmount: tx.amount / 100,
      deliveryAddress: {
        address: metadata.address,
        state: metadata.state,
        country: metadata.country || "Nigeria",
        phone: metadata.phone,
      },
      paymentRef: tx.reference,
      status: "paid",
      email: tx.customer?.email,
      items: cart,
      itemNames: cart.map((item, index) => item.title || item.name || `item-${index + 1}`),
      instructions: "Delivery will take 3–7 days. Ensure your WhatsApp and email are active.",
    });
  } catch (err: any) {
    // Verify and the webhook can arrive together; the unique index lets only one of them create the order.
    if (err?.code === 11000) {
      const order = await Order.findOne({ paymentRef: tx.reference });
      if (order) return order;
    }
    throw err;
  }
}
