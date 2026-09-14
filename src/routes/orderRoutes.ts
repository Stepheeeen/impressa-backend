import express from "express";
import {
  deleteOrder,
  getAllOrders,
  getAllOrdersForUser,
  getOrder,
  updateOrderStatus,
  updateOrderTracking,
} from "../controllers/orderController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { isAdmin } from "../middleware/isAdmin";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();

router.get("/", protect, isAdmin, asyncHandler(getAllOrders));

// move user-specific route before param route so it isn't shadowed
router.get("/user/me", protect, asyncHandler(getAllOrdersForUser));

router.get("/:id", protect, validateObjectId("id"), asyncHandler(getOrder));
router.patch("/:id/status", protect, isAdmin, validateObjectId("id"), asyncHandler(updateOrderStatus));
router.patch("/:id/tracking", protect, isAdmin, validateObjectId("id"), asyncHandler(updateOrderTracking));

// Optional: Delete an order
router.delete("/:id", protect, isAdmin, validateObjectId("id"), asyncHandler(deleteOrder));

export default router;
