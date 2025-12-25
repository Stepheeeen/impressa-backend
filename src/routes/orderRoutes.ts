import express from "express";
import {
  deleteOrder,
  getAllOrders,
  getAllOrdersForUser,
  getOrder,
  updateOrderStatus,
} from "../controllers/orderController";
import { protect } from "../middleware/authMiddleware";
import { isAdmin } from "../middleware/isAdmin";

const router = express.Router();

router.get("/", protect, isAdmin, getAllOrders);

// move user-specific route before param route so it isn't shadowed
router.get("/user/me", protect, getAllOrdersForUser);

router.get("/:id", protect, getOrder);
router.patch("/:id/status", protect, isAdmin, updateOrderStatus);

// Optional: Delete an order
router.delete("/:id", protect, isAdmin, deleteOrder);

export default router;
