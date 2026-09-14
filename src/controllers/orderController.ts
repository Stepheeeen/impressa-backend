import { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import Order, { ORDER_STATUSES, TRACKING_STATUSES } from "../models/Order";
import { setOrderStatus, updateTracking, withFulfilments } from "../services/fulfilments";

const StatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, { error: "Invalid order status" }),
});

export const TrackingSchema = z.object({
  tracking: z.object(
    {
      status: z.preprocess(
        (value) => (value === "" ? null : value),
        z.enum(TRACKING_STATUSES, { error: "Invalid tracking status" }).nullish()
      ),
      code: z.string().trim().max(300, "Tracking code is too long.").nullish(),
    },
    { error: "Tracking details are required." }
  ),
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

// Members who helped pay for a shared cart see its order too.
const visibleTo = (userId: unknown) => ({ $or: [{ user: userId }, { "payers.user": userId }] });

// Only the person who placed an order can return or review its items, so the apps need to know whose it is.
const markShared = (order: any, userId: unknown) => ({
  ...order,
  sharedWithYou: String(order.user?._id ?? order.user) !== String(userId),
});

// GET /api/orders/:id
export const getOrder = async (req: Request, res: Response) => {
  const user = req.user!;
  const isAdmin = user.role === "admin";
  const query = isAdmin ? { _id: req.params.id } : { _id: req.params.id, ...visibleTo(user._id) };

  const order = await populateItems(Order.findOne(query));
  if (!order) throw new HttpError(404, "Order not found");

  const [withParcels] = await withFulfilments([withItemNames(order)], isAdmin ? "admin" : "customer");
  res.json(isAdmin ? withParcels : markShared(withParcels, user._id));
};

// GET /api/orders/user/me
export const getAllOrdersForUser = async (req: Request, res: Response) => {
  const orders = await populateItems(Order.find(visibleTo(req.user!._id)).sort({ createdAt: -1 }));
  const withParcels = await withFulfilments(orders.map(withItemNames), "customer");
  res.json(withParcels.map((order) => markShared(order, req.user!._id)));
};

// GET /api/orders (admins only)
export const getAllOrders = async (_req: Request, res: Response) => {
  const orders = await populateItems(Order.find().populate("user", "username email").sort({ createdAt: -1 }));
  res.json(await withFulfilments(orders.map(withItemNames), "admin"));
};

// PATCH /api/orders/:id/status (admins only)
export const updateOrderStatus = async (req: Request, res: Response) => {
  const { status } = StatusSchema.parse(req.body ?? {});

  const order = await setOrderStatus(req.params.id, status);
  if (!order) throw new HttpError(404, "Order not found");

  res.json({ message: `Order marked as ${status}`, order });
};

// PATCH /api/orders/:id/tracking (admins only)
export const updateOrderTracking = async (req: Request, res: Response) => {
  const { tracking } = TrackingSchema.parse(req.body ?? {});

  const order = await updateTracking(req.params.id, tracking);
  if (!order) throw new HttpError(404, "Order not found");

  res.json({ message: "Tracking updated", order });
};

// DELETE /api/orders/:id (admins only)
export const deleteOrder = async (req: Request, res: Response) => {
  const deleted = await Order.findByIdAndDelete(req.params.id);
  if (!deleted) throw new HttpError(404, "Order not found");
  res.json({ message: "Order deleted successfully" });
};
