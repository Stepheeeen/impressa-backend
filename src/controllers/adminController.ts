// src/controllers/adminController.ts
import { Request, Response } from "express";
import Order from "../models/Order";
import Design from "../models/Design";

// GET /api/admin/orders
export const getAllOrders = async (req: Request, res: Response) => {
  try {
    const orders = await Order.find().populate("user", "name email");
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
};

// PATCH /api/admin/orders/:id
export const updateOrderStatus = async (req: Request, res: Response) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    order.status = req.body.status || order.status;
    await order.save();

    res.json({ message: "Order updated", order });
  } catch (err) {
    res.status(500).json({ error: "Failed to update order" });
  }
};

// GET /api/admin/designs
export const getAllDesigns = async (req: Request, res: Response) => {
  try {
    const designs = await Design.find().populate("user", "name email");
    res.json(designs);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch designs" });
  }
};
