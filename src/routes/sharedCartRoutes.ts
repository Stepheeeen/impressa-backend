import express from "express";
import {
  addSharedCartItem,
  cancelSharedCheckout,
  createSharedCart,
  deleteSharedCart,
  getSharedCart,
  joinSharedCart,
  leaveSharedCart,
  listSharedCarts,
  paySharedCartShare,
  quoteSharedCart,
  removeSharedCartItem,
  removeSharedCartMember,
  renameSharedCart,
  startSharedCheckout,
  updateSharedCartItem,
} from "../controllers/sharedCartController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();
const validId = validateObjectId("id");

router.post("/shared-carts", protect, asyncHandler(createSharedCart));
router.get("/shared-carts", protect, asyncHandler(listSharedCarts));
router.post("/shared-carts/join", protect, asyncHandler(joinSharedCart));
router.get("/shared-carts/:id", protect, validId, asyncHandler(getSharedCart));
router.patch("/shared-carts/:id", protect, validId, asyncHandler(renameSharedCart));
router.delete("/shared-carts/:id", protect, validId, asyncHandler(deleteSharedCart));
router.post("/shared-carts/:id/leave", protect, validId, asyncHandler(leaveSharedCart));
router.delete("/shared-carts/:id/members/:userId", protect, validId, validateObjectId("userId"), asyncHandler(removeSharedCartMember));
router.post("/shared-carts/:id/items", protect, validId, asyncHandler(addSharedCartItem));
router.patch("/shared-carts/:id/items/:itemId", protect, validId, validateObjectId("itemId"), asyncHandler(updateSharedCartItem));
router.delete("/shared-carts/:id/items/:itemId", protect, validId, validateObjectId("itemId"), asyncHandler(removeSharedCartItem));
router.post("/shared-carts/:id/quote", protect, validId, asyncHandler(quoteSharedCart));
router.post("/shared-carts/:id/checkout", protect, validId, asyncHandler(startSharedCheckout));
router.post("/shared-carts/:id/checkout/pay", protect, validId, asyncHandler(paySharedCartShare));
router.post("/shared-carts/:id/checkout/cancel", protect, validId, asyncHandler(cancelSharedCheckout));

export default router;
