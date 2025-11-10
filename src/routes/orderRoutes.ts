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

router.get("/:id", protect, getOrder);
router.get("/user/me", protect, getAllOrdersForUser);
router.patch("/:id/status", protect, isAdmin, updateOrderStatus);
router.get("/", protect, isAdmin, getAllOrders);

// Optional: Delete an order
router.delete("/:id", protect, isAdmin, deleteOrder);


export default router;
