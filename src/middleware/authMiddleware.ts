import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User";

export const protect = async (req: Request & { user?: any }, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authorized, token missing" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const secret = process.env.JWT_SECRET as string;
    if (!secret) throw new Error("JWT_SECRET not set");

    const decoded = jwt.verify(token, secret) as { id: string };
    const user = await User.findById(decoded.id).select("-password");
    if (!user) return res.status(401).json({ error: "Not authorized, user not found" });

    req.user = user;
    next();
  } catch (err: any) {
    // Expired tokens should be handled explicitly so frontend can refresh or prompt login
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "TokenExpired", message: "JWT expired", expiredAt: err.expiredAt });
    }

    console.error("Auth middleware error:", err);
    return res.status(401).json({ error: "Not authorized" });
  }
};
