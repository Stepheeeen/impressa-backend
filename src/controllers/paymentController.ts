import { Request, Response } from "express";
import axios from "axios";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY as string;
const CALLBACK_URL = process.env.PAYSTACK_CALLBACK_URL as string;

export const initializePayment = async (req: any, res: Response) => {
  try {
    console.log("===== Payment Init Request =====");
    console.log("Env PAYSTACK_SECRET_KEY:", PAYSTACK_SECRET ? "SET" : "NOT SET");
    console.log("Env CALLBACK_URL:", CALLBACK_URL);

    const userEmail = req.body.email;
    const amount = req.body.amount;
    const orderId = req.body.orderId;

    console.log("Request Body:", req.body);

    if (!userEmail || !amount) {
      console.error("Missing email or amount");
      return res.status(400).json({ error: "Email and amount are required" });
    }

    const amountInKobo = Number(amount) * 100;

    if (isNaN(amountInKobo) || amountInKobo <= 0) {
      console.error("Invalid amount:", amountInKobo);
      return res.status(400).json({ error: "Amount must be a valid number greater than 0" });
    }

    console.log("Amount in Kobo:", amountInKobo);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: userEmail,
        amount: amountInKobo,
        callback_url: CALLBACK_URL,
        metadata: {
          orderId: orderId || "N/A",
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

    console.log("Paystack Response:", response.data);

    const data = response.data.data;

    return res.json({
      authorization_url: data.authorization_url,
      reference: data.reference,
    });
  } catch (err: any) {
    console.error("===== Paystack Init Error =====");
    console.error("Error Message:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Headers:", err.response.headers);
      console.error("Data:", err.response.data);
    } else {
      console.error(err);
    }
    return res.status(500).json({ error: "Payment initialization failed" });
  }
};
