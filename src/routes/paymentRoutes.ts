import express from "express";
import { initializePayment } from "../controllers/paymentController";
import { protect } from "../middleware/authMiddleware";
import { verifyPayment } from "../controllers/verifyPaymentController";

const router = express.Router();

router.post("/initialize", protect, initializePayment);
router.get("/verify/:reference", protect, verifyPayment);


export default router;
