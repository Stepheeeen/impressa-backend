import express from "express";
import { env } from "../config/env";

const router = express.Router();

// GET /api/app/config — read by the mobile app on launch. Raising a minimum version forces older apps to update.
router.get("/config", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    minimumVersion: {
      ios: env.MIN_APP_VERSION_IOS,
      android: env.MIN_APP_VERSION_ANDROID,
    },
    storeUrl: {
      ios: env.IOS_APP_STORE_URL ?? null,
      android: env.ANDROID_PLAY_STORE_URL,
    },
  });
});

export default router;
