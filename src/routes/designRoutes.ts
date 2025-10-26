import express from "express";
import {
  createDesign,
  getDesign,
  getUserDesigns,
  deleteDesign,
} from "../controllers/designController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createDesign);
router.get("/:id", protect, getDesign);
router.get("/user/me", protect, getUserDesigns);
router.delete("/:id", protect, deleteDesign);

export default router;
