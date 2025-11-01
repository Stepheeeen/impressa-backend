import express from "express";
import { register, login, getMe, adminRegister, adminLogin } from "../controllers/authController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/register", register);
router.post("/register-admin", adminRegister);
router.post("/login", login);
router.post("/admin-login", adminLogin);
router.get("/me", protect, getMe);

export default router;
