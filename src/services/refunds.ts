import * as Sentry from "@sentry/node";
import Order, { IOrder } from "../models/Order";
import { refundTransaction } from "./paystack";
import { creditWallet } from "./wallet";

// Refunds are the customer's own money, so refund credit effectively never expires.
const REFUND_CREDIT_DAYS = 3650;

export type RefundDestination = "wallet" | "card";

// What the customer actually paid for some items, after the order's coupon discount.
export function paidItemsValueKobo(order: Pick<IOrder, "pricing"> | null, itemsValueKobo: number) {
  const pricing = order?.pricing;
  if (!pricing || pricing.subtotalKobo <= 0) return itemsValueKobo;
  return Math.floor((itemsValueKobo * (pricing.subtotalKobo - pricing.discountKobo)) / pricing.subtotalKobo);
}

// Refunds an amount for an order. With "card", as much as possible goes back to the card (never more than
// the card paid); the rest, or everything if the card refund fails, becomes wallet credit.
export async function refundOrderAmount({
  orderId,
  amountKobo,
  destination,
  idempotencyKey,
  note,
}: {
  orderId: string;
  amountKobo: number;
  destination: RefundDestination;
  idempotencyKey: string;
  note: string;
}) {
  if (amountKobo <= 0) return { cardKobo: 0, walletKobo: 0 };

  const order = await Order.findById(orderId).lean();
  if (!order) throw new Error(`Order ${orderId} not found for refund`);

  let cardKobo = 0;
  if (destination === "card") {
    const cardPaidKobo = order.pricing?.cardPaidKobo ?? Math.round(order.totalAmount * 100);
    const wantedKobo = Math.min(amountKobo, cardPaidKobo - (order.cardRefundedKobo ?? 0));

    if (wantedKobo > 0) {
      // Reserve the card amount first, so parallel refunds can't add up to more than the card paid.
      const reserved = await Order.updateOne(
        {
          _id: order._id,
          $expr: { $lte: [{ $add: [{ $ifNull: ["$cardRefundedKobo", 0] }, wantedKobo] }, cardPaidKobo] },
        },
        { $inc: { cardRefundedKobo: wantedKobo } }
      );

      if (reserved.modifiedCount === 1) {
        try {
          await refundTransaction({ reference: order.paymentRef, amountKobo: wantedKobo, merchantNote: note });
          cardKobo = wantedKobo;
        } catch (err) {
          await Order.updateOne({ _id: order._id }, { $inc: { cardRefundedKobo: -wantedKobo } });
          console.error(`Card refund for order ${order._id} failed; refunding to wallet instead`, err);
          Sentry.captureException(err);
        }
      }
    }
  }

  const walletKobo = amountKobo - cardKobo;
  if (walletKobo > 0) {
    await creditWallet({
      userId: String(order.user),
      amountKobo: walletKobo,
      source: "refund",
      expiryDays: REFUND_CREDIT_DAYS,
      idempotencyKey: `${idempotencyKey}:wallet`,
      reference: String(order._id),
      note,
    });
  }

  return { cardKobo, walletKobo };
}
