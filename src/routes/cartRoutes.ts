import express from "express";
import {
  addToCart,
  getCart,
  removeFromCart,
  clearCart
} from "../controllers/cartController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/add", protect, addToCart);
router.get("/", protect, getCart);
router.delete("/remove/:itemId", protect, removeFromCart);
router.delete("/clear", protect, clearCart);

export default router;