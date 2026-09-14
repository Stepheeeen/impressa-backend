import express from "express";
import {
  createDesign,
  getDesign,
  getUserDesigns,
  deleteDesign,
} from "../controllers/designController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();

router.post("/", protect, asyncHandler(createDesign));
router.get("/user/me", protect, asyncHandler(getUserDesigns));
router.get("/:id", protect, validateObjectId("id"), asyncHandler(getDesign));
router.delete("/:id", protect, validateObjectId("id"), asyncHandler(deleteDesign));

export default router;
