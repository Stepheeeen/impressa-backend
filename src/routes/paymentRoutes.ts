import express from "express";
import { initializePayment } from "../controllers/paymentController";
import { protect } from "../middleware/authMiddleware";
import { paystackWebhook, verifyPayment } from "../controllers/verifyPaymentController";

const router = express.Router();

router.post("/initialize", protect, initializePayment);
router.get("/verify/:reference", protect, verifyPayment);
router.post("/webhook", paystackWebhook);


export default router;
