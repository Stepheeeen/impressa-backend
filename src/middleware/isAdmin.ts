// src/middleware/isAdmin.ts
import { Request, Response, NextFunction } from "express";

export const isAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.user && req.user.role === "admin") {
    return next();
  } else {
    return res.status(403).json({ error: "Access denied: Admins only." });
  }
};
