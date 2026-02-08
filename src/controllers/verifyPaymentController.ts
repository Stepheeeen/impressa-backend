import axios from "axios";
import crypto from "crypto";
import { createOrderForUser } from "./orderController";
import { Request, Response } from "express";
import Order from "../models/Order";

export const verifyPayment = async (req: any, res: Response) => {
  try {
    const reference = req.params.reference;
    if (!reference) {
      return res.status(400).json({ error: "Reference is required" });
    }

    const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      }
    );

    const data = response.data.data;

    if (!data || data.status !== "success") {
      return res.status(400).json({
        error: "Payment not successful",
        gateway_response: data?.gateway_response,
      });
    }

    const userId = data.metadata?.userId;
    const metadata = data.metadata;

    const existing = await Order.findOne({ paymentRef: data.reference });
    if (existing) {
      return res.json({
        status: "success",
        message: "Payment already verified & order exists",
        orderId: existing._id,
        reference: data.reference,
      });
    }

    const newOrder = await createOrderForUser({
      userId,
      email: data.customer?.email,
      reference: data.reference,
      metadata,
      amount: data.amount / 100,
    });

    return res.json({
      status: "success",
      message: "Payment verified & order created",
      orderId: newOrder._id,
      reference: data.reference,
    });
  } catch (err: any) {
    console.error("VERIFY ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: "Payment verification failed" });
  }
};

export const paystackWebhook = async (req: Request, res: Response) => {
  try {
    const signature = req.headers["x-paystack-signature"] as string | undefined;
    const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY as string;

    if (!signature || !PAYSTACK_SECRET) {
      return res.status(400).json({ error: "Missing signature or secret" });
    }

    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (hash !== signature) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = req.body;

    if (event?.event !== "charge.success") {
      return res.status(200).json({ received: true });
    }

    const data = event.data;
    if (!data || data.status !== "success") {
      return res.status(200).json({ received: true });
    }

    const existing = await Order.findOne({ paymentRef: data.reference });
    if (existing) {
      return res.status(200).json({ received: true, orderId: existing._id });
    }

    const metadata = data.metadata || {};
    const userId = metadata.userId;

    if (!userId) {
      console.warn("Paystack webhook missing userId metadata", {
        reference: data.reference,
      });
      return res.status(200).json({ received: true });
    }

    const newOrder = await createOrderForUser({
      userId,
      email: data.customer?.email,
      reference: data.reference,
      metadata,
      amount: data.amount / 100,
    });

    return res.status(200).json({ received: true, orderId: newOrder._id });
  } catch (err: any) {
    console.error("PAYSTACK WEBHOOK ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
};
