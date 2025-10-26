// src/routes/adminRoutes.ts
import express from "express";
import {
  getAllOrders,
  updateOrderStatus,
  getAllDesigns,
} from "../controllers/adminController";
import { protect } from "../middleware/authMiddleware";
import { isAdmin } from "../middleware/isAdmin";

const router = express.Router();

router.use(protect, isAdmin); // All routes below are protected + admin-only

router.get("/orders", getAllOrders);
router.patch("/orders/:id", updateOrderStatus);
router.get("/designs", getAllDesigns);

export default router;
