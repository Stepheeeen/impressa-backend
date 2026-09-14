import express from "express";
import {
  applyToSell,
  changeBankAccount,
  createMyProduct,
  deleteMyProduct,
  getBanks,
  getIdUploadSignature,
  getMerchantSummary,
  getMyMerchant,
  listMyFulfilments,
  listMyProducts,
  resolveAccount,
  updateMyFulfilmentTracking,
  updateMyMerchant,
  updateMyProduct,
  updateMyProductStock,
} from "../controllers/merchantController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { requireApprovedMerchant } from "../middleware/merchant";
import { bankLookupLimiter } from "../middleware/rateLimit";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();
const validId = validateObjectId("id");
const seller = [protect, requireApprovedMerchant];

// Applying to sell
router.get("/merchant/banks", protect, asyncHandler(getBanks));
router.post("/merchant/bank/resolve", protect, bankLookupLimiter, asyncHandler(resolveAccount));
router.post("/merchant/id-upload-signature", protect, asyncHandler(getIdUploadSignature));
router.post("/merchant/application", protect, bankLookupLimiter, asyncHandler(applyToSell));
router.get("/merchant/me", protect, asyncHandler(getMyMerchant));

// Approved merchants
router.put("/merchant/me", ...seller, asyncHandler(updateMyMerchant));
router.put("/merchant/me/bank", ...seller, bankLookupLimiter, asyncHandler(changeBankAccount));
router.get("/merchant/summary", ...seller, asyncHandler(getMerchantSummary));

router.get("/merchant/products", ...seller, asyncHandler(listMyProducts));
router.post("/merchant/products", ...seller, asyncHandler(createMyProduct));
router.put("/merchant/products/:id", ...seller, validId, asyncHandler(updateMyProduct));
router.patch("/merchant/products/:id/stock", ...seller, validId, asyncHandler(updateMyProductStock));
router.delete("/merchant/products/:id", ...seller, validId, asyncHandler(deleteMyProduct));

router.get("/merchant/fulfilments", ...seller, asyncHandler(listMyFulfilments));
router.patch("/merchant/fulfilments/:id/tracking", ...seller, validId, asyncHandler(updateMyFulfilmentTracking));

export default router;
