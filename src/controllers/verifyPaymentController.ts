import crypto from "crypto";
import { Request, Response } from "express";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { createOrderFromPayment, parseMetadata, PaymentMismatchError } from "../services/orders";
import { applyTransferStatus } from "../services/payouts";
import { verifyTransaction } from "../services/paystack";
import { applySharedCartPayment, SHARED_CART_PAYMENT } from "../services/sharedCarts";

const REFERENCE = /^[A-Za-z0-9._=-]{1,100}$/;

// GET /api/pay/verify/:reference
export const verifyPayment = async (req: Request, res: Response) => {
  const { reference } = req.params;
  if (!REFERENCE.test(reference)) throw new HttpError(400, "Invalid payment reference.");

  const tx = await verifyTransaction(reference);
  // Clients poll this and treat 400 as "not paid yet".
  if (!tx || tx.status !== "success") {
    return res.status(400).json({ error: "Payment not successful", gateway_response: tx?.gateway_response });
  }

  const metadata = parseMetadata(tx.metadata);
  if (String(metadata.userId) !== String(req.user!.id)) {
    throw new HttpError(404, "Payment not found.");
  }

  try {
    if (metadata.kind === SHARED_CART_PAYMENT) {
      const checkout = await applySharedCartPayment({ reference: tx.reference, amountKobo: tx.amount, currency: tx.currency });
      const refunded = checkout.payments.find((payment) => payment.reference === tx.reference)?.status === "refunded";
      return res.json({
        status: "success",
        message: refunded ? "This payment wasn't needed, so it's being refunded." : "Payment verified",
        sharedCartId: String(checkout.sharedCart),
        orderId: checkout.order ?? null,
        refunded,
        reference: tx.reference,
      });
    }

    const order = await createOrderFromPayment(tx);
    return res.json({ status: "success", message: "Payment verified", orderId: order._id, reference: tx.reference });
  } catch (err) {
    if (err instanceof PaymentMismatchError) {
      throw new HttpError(409, `We couldn't match this payment to your order. Contact support with reference ${tx.reference}.`);
    }
    throw err;
  }
};

// POST /api/pay/webhook
export const paystackWebhook = async (req: Request, res: Response) => {
  const signature = req.headers["x-paystack-signature"];
  if (typeof signature !== "string" || !req.rawBody) {
    return res.status(400).json({ error: "Missing signature" });
  }

  const expected = crypto.createHmac("sha512", env.PAYSTACK_SECRET_KEY).update(req.rawBody).digest("hex");
  const valid =
    signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.status(401).json({ error: "Invalid signature" });

  const event = req.body;

  // Merchant payouts report back through transfer events.
  if (typeof event?.event === "string" && event.event.startsWith("transfer.") && event.data?.reference) {
    const status = event.event === "transfer.success" ? "success" : event.event === "transfer.reversed" ? "reversed" : "failed";
    await applyTransferStatus(String(event.data.reference), status, event.data.transfer_code, event.data.reason);
    return res.json({ received: true });
  }

  if (event?.event !== "charge.success" || event.data?.status !== "success") {
    return res.json({ received: true });
  }

  try {
    if (parseMetadata(event.data.metadata).kind === SHARED_CART_PAYMENT) {
      await applySharedCartPayment({
        reference: String(event.data.reference),
        amountKobo: Number(event.data.amount),
        currency: String(event.data.currency),
      });
      return res.json({ received: true });
    }

    const order = await createOrderFromPayment(event.data);
    return res.json({ received: true, orderId: order._id });
  } catch (err) {
    // A mismatch is already logged for manual review; retrying won't fix it, so acknowledge.
    // Anything else returns 500 so Paystack retries.
    if (err instanceof PaymentMismatchError) return res.json({ received: true });
    throw err;
  }
};
