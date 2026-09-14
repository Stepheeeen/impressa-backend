import { Request, Response } from "express";
import { HttpError } from "../middleware/errorHandler";
import GroupBuy from "../models/GroupBuy";
import { startGroupBuy, toGroupBuyResponse } from "../services/groupBuys";

const CODE = /^[A-Za-z0-9_-]{6,20}$/;

// POST /api/templates/:id/group-buys — starts a group, or returns the one this shopper already started.
export const createGroupBuy = async (req: Request, res: Response) => {
  const group = await startGroupBuy({ productId: req.params.id, userId: req.user!.id });
  res.status(201).json({
    message: "Group buy started. Share the link so others can join.",
    groupBuy: toGroupBuyResponse(group, req.user!.id),
  });
};

// GET /api/templates/:id/group-buys — open groups a shopper can join, ending soonest first.
export const listProductGroupBuys = async (req: Request, res: Response) => {
  const groups = await GroupBuy.find({ product: req.params.id, status: "open", expiresAt: { $gt: new Date() } })
    .sort({ expiresAt: 1 })
    .limit(10)
    .lean();
  res.json(groups.map((group) => toGroupBuyResponse(group, req.user?.id)));
};

// GET /api/group-buys/mine — groups this shopper started or bought through.
export const listMyGroupBuys = async (req: Request, res: Response) => {
  const userId = req.user!._id;
  const groups = await GroupBuy.find({ $or: [{ starter: userId }, { "participants.user": userId }] })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json(groups.map((group) => toGroupBuyResponse(group, req.user!.id)));
};

// GET /api/group-buys/:code
export const getGroupBuy = async (req: Request, res: Response) => {
  const notFound = new HttpError(404, "Group buy not found.");
  if (!CODE.test(req.params.code)) throw notFound;
  const group = await GroupBuy.findOne({ code: req.params.code }).lean();
  if (!group) throw notFound;
  res.json(toGroupBuyResponse(group, req.user?.id));
};
