import { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import Order, { ORDER_STATUSES } from "../models/Order";

const StatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, { error: "Invalid order status" }),
});

// Older orders don't always store item titles, so fall back through everything that might hold one.
function withItemNames(order: any) {
  const obj = order.toObject();
  obj.items = (obj.items || []).map((it: any, idx: number) => ({
    ...it,
    name: it.title || it.name || it.templateId?.title || it.designId?.title || obj.itemNames?.[idx] || `item-${idx + 1}`,
  }));
  return obj;
}

const populateItems = <T extends { populate: (...args: any[]) => T }>(query: T) =>
  query
    .populate({ path: "items.templateId", model: "ProductTemplate", select: "title imageUrls price sizes colors inStock" })
    .populate({ path: "items.designId", model: "Design", select: "title imageUrl" });

// GET /api/orders/:id
export const getOrder = async (req: Request, res: Response) => {
  const user = req.user!;
  const query = user.role === "admin" ? { _id: req.params.id } : { _id: req.params.id, user: user._id };

  const order = await populateItems(Order.findOne(query));
  if (!order) throw new HttpError(404, "Order not found");

  res.json(withItemNames(order));
};

// GET /api/orders/user/me
export const getAllOrdersForUser = async (req: Request, res: Response) => {
  const orders = await populateItems(Order.find({ user: req.user!._id }).sort({ createdAt: -1 }));
  res.json(orders.map(withItemNames));
};

// GET /api/orders (admins only)
export const getAllOrders = async (_req: Request, res: Response) => {
  const orders = await populateItems(Order.find().populate("user", "username email").sort({ createdAt: -1 }));
  res.json(orders.map(withItemNames));
};

// PATCH /api/orders/:id/status (admins only)
export const updateOrderStatus = async (req: Request, res: Response) => {
  const { status } = StatusSchema.parse(req.body ?? {});

  const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!order) throw new HttpError(404, "Order not found");

  res.json({ message: `Order marked as ${status}`, order });
};

// DELETE /api/orders/:id (admins only)
export const deleteOrder = async (req: Request, res: Response) => {
  const deleted = await Order.findByIdAndDelete(req.params.id);
  if (!deleted) throw new HttpError(404, "Order not found");
  res.json({ message: "Order deleted successfully" });
};
