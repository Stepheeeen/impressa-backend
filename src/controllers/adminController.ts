// src/controllers/adminController.ts
import { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import Design from "../models/Design";
import Order, { ORDER_STATUSES } from "../models/Order";
import { setOrderStatus } from "../services/fulfilments";

const StatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, { error: "Invalid order status" }),
});

// GET /api/admin/orders
export const getAllOrders = async (_req: Request, res: Response) => {
  const orders = await Order.find()
    .populate("user", "username email")
    .populate({
      path: "items.templateId",
      model: "ProductTemplate",
      select: "title imageUrls price sizes colors inStock",
    })
    .populate({
      path: "items.designId",
      model: "Design",
      select: "title imageUrl",
    })
    .sort({ createdAt: -1 });
  res.json(orders);
};

// PATCH /api/admin/orders/:id
export const updateOrderStatus = async (req: Request, res: Response) => {
  const { status } = StatusSchema.parse(req.body ?? {});

  const order = await setOrderStatus(req.params.id, status);
  if (!order) throw new HttpError(404, "Order not found");

  res.json({ message: "Order updated", order });
};

// GET /api/admin/designs
export const getAllDesigns = async (_req: Request, res: Response) => {
  const designs = await Design.find().populate("user", "username email");
  res.json(designs);
};
