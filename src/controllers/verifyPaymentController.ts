import axios from "axios";
import { createOrderForUser } from "./orderController";
import { Response } from "express";

export const verifyPayment = async (req: any, res: Response) => {
    try {
        const reference = req.params.reference;

        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                },
            }
        );

        const data = response.data.data;

        if (data.status !== "success") {
            return res.status(400).json({ error: "Payment not successful" });
        }

        // ✅ Create order ONLY after successful payment
        const order = await createOrderForUser(req.user.id, reference);

        res.json({
            message: "Payment verified",
            orderId: order._id,
        });
    } catch (err:any) {
        console.error(err.response?.data || err);
        res.status(500).json({ error: "Payment verification failed" });
    }
};
