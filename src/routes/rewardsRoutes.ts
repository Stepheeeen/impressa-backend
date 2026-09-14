import express from "express";
import { claimCheckIn, claimScratchCard, getRewards, getWallet } from "../controllers/walletController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";

const router = express.Router();

router.get("/wallet", protect, asyncHandler(getWallet));
router.get("/rewards", protect, asyncHandler(getRewards));
router.post("/rewards/check-in", protect, asyncHandler(claimCheckIn));
router.post("/rewards/scratch-cards", protect, asyncHandler(claimScratchCard));

export default router;
