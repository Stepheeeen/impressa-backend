// src/routes/adminRoutes.ts
import express from "express";
import {
  getAllOrders,
  updateOrderStatus,
  getAllDesigns,
} from "../controllers/adminController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { isAdmin } from "../middleware/isAdmin";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();

router.use(protect, isAdmin); // All routes below are protected + admin-only

router.get("/orders", asyncHandler(getAllOrders));
router.patch("/orders/:id", validateObjectId("id"), asyncHandler(updateOrderStatus));
router.get("/designs", asyncHandler(getAllDesigns));

export default router;
