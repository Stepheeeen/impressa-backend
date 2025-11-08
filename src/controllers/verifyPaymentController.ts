import axios from "axios";
import { createOrderForUser } from "./orderController";
import { Response } from "express";

export const verifyPayment = async (req: any, res: Response) => {
  try {
    const reference = req.query.reference;
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
    const customerEmail = data.customer?.email;
    const paidAmount = data.amount / 100;

    // ✅ Create order
    const newOrder = await createOrderForUser({
      userId,
      email: customerEmail,
      reference: data.reference,
      amount: paidAmount,
      metadata: data.metadata,
    });

    return res.json({
      message: "Payment verified & order created",
      orderId: newOrder._id,
      reference: data.reference,
      amount: paidAmount,
      status: data.status,
    });

  } catch (err: any) {
    console.error("VERIFY ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: "Payment verification failed" });
  }
};

