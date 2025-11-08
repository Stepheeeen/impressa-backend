import { Request, Response } from "express";
import Order from "../models/Order";
import Cart from "../models/Cart";

// POST /api/orders
export const createOrderForUser = async (userId: string, reference: string) => {
  const cart = await Cart.findOne({ user: userId });

  if (!cart || cart.items.length === 0) {
    throw new Error("Cannot create order. Cart is empty.");
  }

  const order = await Order.create({
    user: userId,
    items: cart.items,
    paymentReference: reference,
    total: cart.items.reduce(
      (acc, item) => acc + (item.price ?? 0) * (item.quantity ?? 1),
      0
    ),
    status: "paid",
  });

  cart.items = [];
  await cart.save();

  return order;
};

// GET /api/orders/:id
export const getOrder = async (req: any, res: Response) => {
  const order = await Order.findOne({
    _id: req.params.id,
    user: req.user.id,
  }).populate("designId templateId");
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
};

// GET /api/users/me/orders
export const getUserOrders = async (req: any, res: Response) => {
  const orders = await Order.find({ user: req.user.id }).sort({ createdAt: -1 });
  res.json(orders);
};
