import express from "express";
import { getDashboardStats } from "../controllers/dashboardController";
import { protect } from "../middleware/authMiddleware";
import { isAdmin } from "../middleware/isAdmin";

const router = express.Router();

router.get("/", protect, isAdmin, getDashboardStats);

export default router;
