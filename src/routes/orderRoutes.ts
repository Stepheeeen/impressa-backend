import express from "express";
import {
  getOrder,
  getUserOrders,
} from "../controllers/orderController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.get("/:id", protect, getOrder);
router.get("/user/me", protect, getUserOrders);

export default router;
