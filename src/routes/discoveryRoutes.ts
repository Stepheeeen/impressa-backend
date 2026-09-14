import express from "express";
import { getHome, getLiveBanners, getPriceBands } from "../controllers/discoveryController";
import { asyncHandler } from "../middleware/errorHandler";

const router = express.Router();

router.get("/home", asyncHandler(getHome));
router.get("/banners", asyncHandler(getLiveBanners));
router.get("/price-bands", asyncHandler(getPriceBands));

export default router;
