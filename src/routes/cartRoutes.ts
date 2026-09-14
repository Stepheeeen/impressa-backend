import express from "express";
import {
  addToCart,
  getCart,
  removeFromCart,
  clearCart,
  updateCartQuantity
} from "../controllers/cartController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();

router.post("/add", protect, asyncHandler(addToCart));
router.get("/", protect, asyncHandler(getCart));
router.delete("/remove/:itemId", protect, validateObjectId("itemId"), asyncHandler(removeFromCart));
router.delete("/clear", protect, asyncHandler(clearCart));
router.post("/update", protect, asyncHandler(updateCartQuantity));

export default router;
