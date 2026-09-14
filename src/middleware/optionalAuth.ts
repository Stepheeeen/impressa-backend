import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import User from "../models/User";
import { isObjectId } from "./validate";

// Sets req.user when a valid token is sent, but never rejects the request. Used on public pages
// that show more to admins (e.g. hidden products in the admin panel).
export const optionalAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();

  try {
    const payload = jwt.verify(header.slice("Bearer ".length), env.JWT_SECRET, { algorithms: ["HS256"] }) as {
      id?: string;
      tv?: number;
    };
    if (isObjectId(payload.id)) {
      const user = await User.findById(payload.id).select("-password");
      if (user && (payload.tv ?? 0) === (user.tokenVersion ?? 0)) req.user = user;
    }
  } catch {
    // An invalid or expired token is treated as signed out.
  }
  next();
};
