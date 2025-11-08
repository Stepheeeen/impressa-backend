import { Request, Response } from "express";
import axios from "axios";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY as string;
const CALLBACK_URL = process.env.PAYSTACK_CALLBACK_URL as string;

export const initializePayment = async (req: any, res: Response) => {
  try {
    const userEmail = req.body.email;
    const amount = req.body.amount;
    const orderId = req.body.orderId;

    if (!userEmail || !amount) {
      return res
        .status(400)
        .json({ error: "Email and amount are required" });
    }

    // ✅ Convert Naira → Kobo
    const amountInKobo = Number(amount) * 100;

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: userEmail,
        amount: amountInKobo,
        callback_url: CALLBACK_URL,
        metadata: {
          orderId,
          userId: req.user?.id || "guest",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = response.data.data;

    res.json({
      authorization_url: data.authorization_url,
      reference: data.reference,
    });
  } catch (err: any) {
    console.error("Paystack Init Error:", err.response?.data || err);
    res.status(500).json({ error: "Payment initialization failed" });
  }
};
