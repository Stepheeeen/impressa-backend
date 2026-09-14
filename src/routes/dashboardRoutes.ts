import express from "express";
import { getDashboardStats } from "../controllers/dashboardController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { isAdmin } from "../middleware/isAdmin";

const router = express.Router();

router.get("/", protect, isAdmin, asyncHandler(getDashboardStats));

export default router;
