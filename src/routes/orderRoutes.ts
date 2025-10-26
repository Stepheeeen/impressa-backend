import express from "express";
import {
  createOrder,
  getOrder,
  getUserOrders,
} from "../controllers/orderController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createOrder);
router.get("/:id", protect, getOrder);
router.get("/user/me", protect, getUserOrders);

export default router;
