import { Request, Response } from "express";
import { z } from "zod";
import DeviceToken from "../models/DeviceToken";
import { isPushToken } from "../services/push";

const RegisterDeviceSchema = z.object({
  token: z.string({ error: "Invalid push token." }).refine(isPushToken, "Invalid push token."),
  platform: z.enum(["ios", "android"], { error: "Platform must be ios or android." }),
  appVersion: z.string().max(20).optional(),
});

const UnregisterDeviceSchema = z.object({
  token: z.string({ error: "Invalid push token." }).min(1, "Invalid push token."),
});

// POST /api/devices
export const registerDevice = async (req: Request, res: Response) => {
  const { token, platform, appVersion } = RegisterDeviceSchema.parse(req.body ?? {});
  await DeviceToken.updateOne(
    { token },
    { $set: { user: req.user!._id, platform, appVersion } },
    { upsert: true }
  );
  res.json({ message: "Device registered" });
};

// DELETE /api/devices
export const unregisterDevice = async (req: Request, res: Response) => {
  const { token } = UnregisterDeviceSchema.parse(req.body ?? {});
  await DeviceToken.deleteOne({ token, user: req.user!._id });
  res.json({ message: "Device removed" });
};
