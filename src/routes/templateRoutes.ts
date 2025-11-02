import express from "express";
import { getTemplates, createTemplate, updateTemplate, deleteTemplate, setProductStock } from "../controllers/templateController";
import { protect } from "../middleware/authMiddleware";
import { isAdmin } from "../middleware/isAdmin";

const router = express.Router();

router.get("/", getTemplates);
router.post("/", createTemplate); // Auth middleware can be added here later
router.put("/:id", protect, isAdmin, updateTemplate);
router.delete("/:id", protect, isAdmin, deleteTemplate);
router.patch("/:id/stock", protect, isAdmin, setProductStock);

export default router;
