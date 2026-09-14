import express from "express";
import { escalateSupport, getSupportConfig, postSupportMessage } from "../controllers/supportController";
import { asyncHandler } from "../middleware/errorHandler";
import { optionalAuth } from "../middleware/optionalAuth";
import { supportChatLimiter } from "../middleware/rateLimit";

const router = express.Router();

// Signed-out visitors can ask general questions; signing in lets the assistant see their own orders.
router.get("/support/config", getSupportConfig);
router.post("/support/messages", optionalAuth, supportChatLimiter, asyncHandler(postSupportMessage));
router.post("/support/escalate", optionalAuth, supportChatLimiter, asyncHandler(escalateSupport));

export default router;
