import express from "express";
import { getTemplates, createTemplate } from "../controllers/templateController";

const router = express.Router();

router.get("/", getTemplates);
router.post("/", createTemplate); // Auth middleware can be added here later

export default router;
