import { NextFunction, Request, Response } from "express";
import Merchant from "../models/Merchant";

// Loads the signed-in user's merchant account. Only approved merchants can sell.
export const requireApprovedMerchant = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const merchant = await Merchant.findOne({ user: req.user!._id });
    if (!merchant) {
      return res.status(403).json({ error: "Apply to sell on Impressa first." });
    }
    if (merchant.status !== "approved") {
      const error =
        merchant.status === "suspended"
          ? "Your merchant account is suspended. Contact Impressa support."
          : "Your merchant application hasn't been approved yet.";
      return res.status(403).json({ error });
    }
    req.merchant = merchant;
    next();
  } catch (err) {
    next(err);
  }
};
