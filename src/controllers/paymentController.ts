import { Request, Response } from "express";
import axios from "axios";

export const initializePayment = async (req: any, res: Response) => {
  try {
    const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
    const {
      email,
      phone,
      amount,
      orderId,
      cart,
      country,
      state,
      address,
      itemType,
      quantity,
    } = req.body;

    if (!email || !amount) {
      return res.status(400).json({ error: "Email and amount are required" });
    }

    const amountInKobo = Number(amount) * 100;

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amountInKobo,
        metadata: {
          userId: req.user?.id || null,
          cart,

          // ✅ flattened delivery info
          phone,
          country,
          state,
          address,

          itemType,
          quantity,
          orderId,
          totalAmount: amount,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json({
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (err: any) {
    console.error("INIT ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: "Payment initialization failed" });
  }
};
