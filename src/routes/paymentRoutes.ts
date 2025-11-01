import express from "express";
import { initializePayment } from "../controllers/paymentController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/initialize", protect, initializePayment);

export default router;
