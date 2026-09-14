import express from "express";
import { createGroupBuy, getGroupBuy, listMyGroupBuys, listProductGroupBuys } from "../controllers/groupBuyController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { optionalAuth } from "../middleware/optionalAuth";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();
const validId = validateObjectId("id");

router.post("/templates/:id/group-buys", protect, validId, asyncHandler(createGroupBuy));
router.get("/templates/:id/group-buys", validId, optionalAuth, asyncHandler(listProductGroupBuys));
router.get("/group-buys/mine", protect, asyncHandler(listMyGroupBuys));
router.get("/group-buys/:code", optionalAuth, asyncHandler(getGroupBuy));

export default router;
