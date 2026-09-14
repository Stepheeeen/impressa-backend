import * as Sentry from "@sentry/node";
import Order, { IOrder } from "../models/Order";
import { refundTransaction } from "./paystack";
import { formatNaira } from "./pricing";
import { notifyUser, orderNumber } from "./push";
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

type RefundRequest = { amountKobo: number; destination: RefundDestination; idempotencyKey: string; note: string };

// A shared cart order: each payer gets back part of the refund in proportion to what they paid,
// to their own card where possible.
async function refundPayers(
  order: { _id: unknown; user: unknown; payers?: IOrder["payers"] },
  { amountKobo, destination, idempotencyKey, note }: RefundRequest
) {
  const payers = order.payers ?? [];
  const paid = payers.map((payer) => payer.cardPaidKobo + payer.walletAppliedKobo);
  const paidTotal = paid.reduce((sum, value) => sum + value, 0);

  const portions = payers.map((_, index) => (paidTotal > 0 ? Math.floor((amountKobo * paid[index]) / paidTotal) : 0));
  if (paidTotal === 0) portions[0] = amountKobo;
  // Rounding leftovers go to whoever paid most.
  const mostPaidFirst = payers.map((_, index) => index).sort((a, b) => paid[b] - paid[a]);
  for (let leftover = amountKobo - portions.reduce((sum, value) => sum + value, 0), k = 0; leftover > 0; leftover--, k++) {
    portions[mostPaidFirst[k % mostPaidFirst.length]] += 1;
  }

  let cardKobo = 0;
  let walletKobo = 0;
  for (const [index, payer] of payers.entries()) {
    const portionKobo = portions[index];
    if (portionKobo <= 0) continue;

    let payerCardKobo = 0;
    const wantedKobo = destination === "card" ? Math.min(portionKobo, payer.cardPaidKobo - (payer.cardRefundedKobo ?? 0)) : 0;
    if (wantedKobo > 0) {
      // Reserved first, so parallel refunds can't add up to more than this payer's card paid.
      const reserved = await Order.updateOne(
        {
          _id: order._id,
          payers: { $elemMatch: { reference: payer.reference, cardRefundedKobo: { $lte: payer.cardPaidKobo - wantedKobo } } },
        },
        { $inc: { "payers.$.cardRefundedKobo": wantedKobo, cardRefundedKobo: wantedKobo } }
      );
      if (reserved.modifiedCount === 1) {
        try {
          await refundTransaction({ reference: payer.reference, amountKobo: wantedKobo, merchantNote: note });
          payerCardKobo = wantedKobo;
        } catch (err) {
          await Order.updateOne(
            { _id: order._id, "payers.reference": payer.reference },
            { $inc: { "payers.$.cardRefundedKobo": -wantedKobo, cardRefundedKobo: -wantedKobo } }
          );
          console.error(`Card refund to payer ${payer.reference} on order ${order._id} failed; refunding to wallet instead`, err);
          Sentry.captureException(err);
        }
      }
    }

    const payerWalletKobo = portionKobo - payerCardKobo;
    if (payerWalletKobo > 0) {
      await creditWallet({
        userId: String(payer.user),
        amountKobo: payerWalletKobo,
        source: "refund",
        expiryDays: REFUND_CREDIT_DAYS,
        idempotencyKey: `${idempotencyKey}:${payer.reference}:wallet`,
        reference: String(order._id),
        note,
      });
    }
    cardKobo += payerCardKobo;
    walletKobo += payerWalletKobo;

    // The person who placed the order hears about refunds from the return or cancellation itself.
    if (String(payer.user) !== String(order.user)) {
      notifyUser({
        userId: String(payer.user),
        title: "You're getting a refund",
        body: `${formatNaira(portionKobo)} from shared order #${orderNumber(String(order._id))} is being refunded${payerCardKobo === 0 ? " to your Impressa wallet" : ""}.`,
        data: { type: "wallet" },
      });
    }
  }

  return { cardKobo, walletKobo };
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
  if (order.payers?.length) return refundPayers(order, { amountKobo, destination, idempotencyKey, note });

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
