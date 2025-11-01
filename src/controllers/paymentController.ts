import { Request, Response } from "express";
import axios from "axios";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY as string;
const CALLBACK_URL = process.env.PAYSTACK_CALLBACK_URL as string;

// ✅ Initialize Paystack Payment
export const initializePayment = async (req: any, res: Response) => {
  try {
    const { email, amount } = req.body;

    if (!email || !amount) {
      return res.status(400).json({ error: "Email and amount are required" });
    }

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100, // Paystack accepts kobo
        callback_url: CALLBACK_URL,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    // ✅ Return authorization URL & reference
    res.json({
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (err: any) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: "Payment initialization failed" });
  }
};
