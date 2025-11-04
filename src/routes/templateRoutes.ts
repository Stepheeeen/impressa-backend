import express from "express";
import { getTemplates, createTemplate, updateTemplate, deleteTemplate, setProductStock, getTemplateById, editTemplate } from "../controllers/templateController";
import { protect } from "../middleware/authMiddleware";
import { isAdmin } from "../middleware/isAdmin";

const router = express.Router();

router.get("/", getTemplates);
router.get("/:id", getTemplateById);

router.post("/", protect, isAdmin, createTemplate);

router.put("/:id", protect, isAdmin, updateTemplate);
router.put("/:id/edit", protect, isAdmin, editTemplate);

router.delete("/:id", protect, isAdmin, deleteTemplate);

router.patch("/:id/stock", protect, isAdmin, setProductStock);

export default router;
