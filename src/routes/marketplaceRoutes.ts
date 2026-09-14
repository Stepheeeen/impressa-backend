import express from "express";
import {
  acceptReturn,
  createReturn,
  escalateMyReturn,
  listMerchantPayouts,
  listMerchantReturns,
  listMyReturns,
  listProductReviews,
  merchantCancelFulfilment,
  postReview,
  rejectReturn,
} from "../controllers/marketplaceController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { requireApprovedMerchant } from "../middleware/merchant";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();
const validId = validateObjectId("id");
const seller = [protect, requireApprovedMerchant];

// Customers
router.post("/fulfilments/:id/returns", protect, validId, asyncHandler(createReturn));
router.get("/returns", protect, asyncHandler(listMyReturns));
router.post("/returns/:id/escalate", protect, validId, asyncHandler(escalateMyReturn));
router.post("/reviews", protect, asyncHandler(postReview));
router.get("/templates/:id/reviews", validId, asyncHandler(listProductReviews));

// Merchants
router.get("/merchant/returns", ...seller, asyncHandler(listMerchantReturns));
router.post("/merchant/returns/:id/accept", ...seller, validId, asyncHandler(acceptReturn));
router.post("/merchant/returns/:id/reject", ...seller, validId, asyncHandler(rejectReturn));
router.post("/merchant/fulfilments/:id/cancel", ...seller, validId, asyncHandler(merchantCancelFulfilment));
router.get("/merchant/payouts", ...seller, asyncHandler(listMerchantPayouts));

export default router;
