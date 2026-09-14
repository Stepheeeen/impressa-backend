import express from "express";
import {
  adminLogin,
  adminRegister,
  deleteAccount,
  forgotPassword,
  getMe,
  login,
  register,
  resetPassword,
} from "../controllers/authController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { isAdmin } from "../middleware/isAdmin";
import { loginLimiter, passwordResetLimiter, registerLimiter } from "../middleware/rateLimit";

const router = express.Router();

router.post("/register", registerLimiter, asyncHandler(register));
router.post("/register-admin", protect, isAdmin, asyncHandler(adminRegister));
router.post("/login", loginLimiter, asyncHandler(login));
router.post("/admin-login", loginLimiter, asyncHandler(adminLogin));
router.post("/forgot-password", passwordResetLimiter, asyncHandler(forgotPassword));
router.post("/reset-password", passwordResetLimiter, asyncHandler(resetPassword));
router.get("/me", protect, asyncHandler(getMe));
router.delete("/me", protect, asyncHandler(deleteAccount));

export default router;
