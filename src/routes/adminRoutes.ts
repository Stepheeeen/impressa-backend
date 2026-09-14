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
  approveMerchant,
  getAdminMarketplaceSettings,
  getMerchantDetail,
  listMerchants,
  overrideFulfilment,
  reinstateMerchant,
  rejectMerchant,
  setMerchantCommission,
  setProductVisibility,
  suspendMerchant,
  updateMarketplaceSettings,
} from "../controllers/adminMerchantsController";
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

router.get("/merchants", asyncHandler(listMerchants));
router.get("/merchants/:id", validId, asyncHandler(getMerchantDetail));
router.post("/merchants/:id/approve", validId, asyncHandler(approveMerchant));
router.post("/merchants/:id/reject", validId, asyncHandler(rejectMerchant));
router.post("/merchants/:id/suspend", validId, asyncHandler(suspendMerchant));
router.post("/merchants/:id/reinstate", validId, asyncHandler(reinstateMerchant));
router.put("/merchants/:id/commission", validId, asyncHandler(setMerchantCommission));

router.get("/marketplace/settings", asyncHandler(getAdminMarketplaceSettings));
router.put("/marketplace/settings", asyncHandler(updateMarketplaceSettings));
router.patch("/fulfilments/:id", validId, asyncHandler(overrideFulfilment));
router.patch("/products/:id/visibility", validId, asyncHandler(setProductVisibility));

export default router;
