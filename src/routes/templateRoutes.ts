import express from "express";
import { getTemplates, createTemplate, updateTemplate, deleteTemplate, setProductStock, getTemplateById, editTemplate } from "../controllers/templateController";
import { protect } from "../middleware/authMiddleware";
import { asyncHandler } from "../middleware/errorHandler";
import { isAdmin } from "../middleware/isAdmin";
import { validateObjectId } from "../middleware/validate";

const router = express.Router();
const validId = validateObjectId("id");

router.get("/", asyncHandler(getTemplates));
router.get("/:id", validId, asyncHandler(getTemplateById));

router.post("/", protect, isAdmin, asyncHandler(createTemplate));

router.put("/:id", protect, isAdmin, validId, asyncHandler(updateTemplate));
router.put("/:id/edit", protect, isAdmin, validId, asyncHandler(editTemplate));

router.delete("/:id", protect, isAdmin, validId, asyncHandler(deleteTemplate));

router.patch("/:id/stock", protect, isAdmin, validId, asyncHandler(setProductStock));

export default router;
