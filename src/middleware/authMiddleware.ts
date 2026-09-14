import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import User from "../models/User";
import { isObjectId } from "./validate";

type TokenPayload = { id?: string; tv?: number };

export const protect = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authorized, token missing" });
  }

  let payload: TokenPayload;
  try {
    payload = jwt.verify(header.slice("Bearer ".length), env.JWT_SECRET, { algorithms: ["HS256"] }) as TokenPayload;
  } catch (err: any) {
    // Expired tokens are reported explicitly so clients can prompt the user to sign in again.
    if (err?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "TokenExpired", message: "JWT expired", expiredAt: err.expiredAt });
    }
    return res.status(401).json({ error: "Not authorized" });
  }

  try {
    const user = isObjectId(payload.id) ? await User.findById(payload.id).select("-password") : null;
    if (!user) return res.status(401).json({ error: "Not authorized, user not found" });

    // Resetting a password bumps tokenVersion, which retires every token issued before it.
    if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ error: "Your session has ended. Sign in again." });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};
