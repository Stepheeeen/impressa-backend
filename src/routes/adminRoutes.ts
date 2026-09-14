// src/routes/adminRoutes.ts
import express from "express";
import {
  getAllOrders,
  updateOrderStatus,
  getAllDesigns,
} from "../controllers/adminController";
import {
  adjustWallet,
  createCoupon,
  deleteCoupon,
  findCustomerWallet,
  getAdminRewardSettings,
  getReconciliation,
  getRewardsSummary,
  listCoupons,
  updateCoupon,
  updateRewardSettings,
} from "../controllers/adminRewardsController";
import {
  createBanner,
  createPriceBand,
  deleteBanner,
  deletePriceBand,
  listBanners,
  listPriceBands,
  updateBanner,
  updatePriceBand,
} from "../controllers/discoveryController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { isAdmin } from "../middleware/isAdmin";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();
const validId = validateObjectId("id");

router.use(protect, isAdmin); // All routes below are protected + admin-only

router.get("/orders", asyncHandler(getAllOrders));
router.patch("/orders/:id", validId, asyncHandler(updateOrderStatus));
router.get("/designs", asyncHandler(getAllDesigns));

router.get("/banners", asyncHandler(listBanners));
router.post("/banners", asyncHandler(createBanner));
router.put("/banners/:id", validId, asyncHandler(updateBanner));
router.delete("/banners/:id", validId, asyncHandler(deleteBanner));

router.get("/price-bands", asyncHandler(listPriceBands));
router.post("/price-bands", asyncHandler(createPriceBand));
router.put("/price-bands/:id", validId, asyncHandler(updatePriceBand));
router.delete("/price-bands/:id", validId, asyncHandler(deletePriceBand));

router.get("/rewards/settings", asyncHandler(getAdminRewardSettings));
router.put("/rewards/settings", asyncHandler(updateRewardSettings));
router.get("/rewards/summary", asyncHandler(getRewardsSummary));

router.get("/coupons", asyncHandler(listCoupons));
router.post("/coupons", asyncHandler(createCoupon));
router.put("/coupons/:id", validId, asyncHandler(updateCoupon));
router.delete("/coupons/:id", validId, asyncHandler(deleteCoupon));

router.get("/wallets", asyncHandler(findCustomerWallet));
router.get("/wallets/reconciliation", asyncHandler(getReconciliation));
router.post("/wallets/:userId/adjustments", validateObjectId("userId"), asyncHandler(adjustWallet));

export default router;
