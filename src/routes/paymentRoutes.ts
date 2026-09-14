import express from "express";
import { initializePayment } from "../controllers/paymentController";
import { paystackWebhook, verifyPayment } from "../controllers/verifyPaymentController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";

const router = express.Router();

router.post("/initialize", protect, asyncHandler(initializePayment));
router.get("/verify/:reference", protect, asyncHandler(verifyPayment));
router.post("/webhook", asyncHandler(paystackWebhook));

export default router;
