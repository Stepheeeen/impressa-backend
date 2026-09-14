import crypto from "crypto";
import { Request, Response } from "express";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { createOrderFromPayment, parseMetadata, PaymentMismatchError } from "../services/orders";
import { verifyTransaction } from "../services/paystack";

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

  if (String(parseMetadata(tx.metadata).userId) !== String(req.user!.id)) {
    throw new HttpError(404, "Payment not found.");
  }

  try {
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
  if (event?.event !== "charge.success" || event.data?.status !== "success") {
    return res.json({ received: true });
  }

  try {
    const order = await createOrderFromPayment(event.data);
    return res.json({ received: true, orderId: order._id });
  } catch (err) {
    // A mismatch is already logged for manual review; retrying won't fix it, so acknowledge.
    // Anything else returns 500 so Paystack retries.
    if (err instanceof PaymentMismatchError) return res.json({ received: true });
    throw err;
  }
};
