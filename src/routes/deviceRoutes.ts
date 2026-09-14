import express from "express";
import { registerDevice, unregisterDevice } from "../controllers/deviceController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";

const router = express.Router();

router.post("/", protect, asyncHandler(registerDevice));
router.delete("/", protect, asyncHandler(unregisterDevice));

export default router;
