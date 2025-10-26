import { Request, Response } from "express";
import Order from "../models/Order";

// POST /api/orders
export const createOrder = async (req: any, res: Response) => {
  const {
    designId,
    templateId,
    itemType,
    quantity,
    totalAmount,
    deliveryAddress,
    paymentRef,
  } = req.body;

  const order = await Order.create({
    user: req.user.id,
    designId,
    templateId,
    itemType,
    quantity,
    totalAmount,
    deliveryAddress,
    paymentRef,
  });

  res.status(201).json(order);
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
