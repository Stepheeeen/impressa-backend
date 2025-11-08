import { Request, Response } from "express";
import Order from "../models/Order";
import Cart from "../models/Cart";

export const createOrderForUser = async ({
  userId,
  reference,
  metadata,
  email,
  amount,
}: {
  userId?: string;
  reference: string;
  metadata: any;
  email?: string;
  amount: number;
}) => {

  let cartItems = [];

  // ✅ Preferred source: metadata.cart
  if (metadata?.cart && Array.isArray(metadata.cart)) {
    cartItems = metadata.cart;
  }
  // ✅ Fallback: DB cart
  else if (userId) {
    const cart = await Cart.findOne({ user: userId });
    if (!cart || cart.items.length === 0) {
      throw new Error("Cart is empty.");
    }
    cartItems = cart.items;

    // Clear cart
    cart.items = [];
    await cart.save();
  } else {
    throw new Error("No cart data found to create order.");
  }

  // ✅ Calculate total
  const totalAmount = cartItems.reduce((acc: any, item: any) => {
    const price = item.price || item.unitPrice || 0;
    return acc + price * (item.quantity ?? 1);
  }, 0);

  // ✅ Create order
  return await Order.create({
    user: userId || null,
    email: email || metadata?.email || null,
    items: cartItems,
    paymentReference: reference,
    total: totalAmount,
    paidAmount: amount,
    status: "paid",
    metadata,
  });
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
