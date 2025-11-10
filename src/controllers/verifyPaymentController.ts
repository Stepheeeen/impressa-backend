import axios from "axios";
import { createOrderForUser } from "./orderController";
import { Response } from "express";

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

    const userId = data.metadata?.userId || req.user?.id || null;
    const metadata = data.metadata;

    const newOrder = await createOrderForUser({
      userId,
      email: data.customer?.email,
      reference: data.reference,
      metadata,
      amount: data.amount / 100,
    });

    return res.json({
      message: "Payment verified & order created",
      status: "success",
      orderId: newOrder._id,
      reference: data.reference,
    });
  } catch (err: any) {
    console.error("VERIFY ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: "Payment verification failed" });
  }
};
