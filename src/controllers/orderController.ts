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

  // ✅ Prefer cart from metadata
  if (metadata?.cart && Array.isArray(metadata.cart)) {
    cartItems = metadata.cart;
  } else if (userId) {
    // ✅ Fallback: load cart from DB
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
  const totalAmount = cartItems.reduce((acc: number, item: any) => {
    const price = item.unitPrice || item.price || 0;
    return acc + price * (item.quantity ?? 1);
  }, 0);

  // ✅ Extract key fields from metadata (for flexibility)
  const itemType =
    metadata.itemType ||
    cartItems[0]?.title ||
    "general-item";

  const quantity =
    metadata.quantity ||
    cartItems.reduce((acc: number, item: any) => acc + (item.quantity ?? 1), 0);

  const deliveryAddress =
    metadata.deliveryAddress ||
    metadata.address ||
    "No delivery address provided";

  // ✅ Create order that matches your schema
  const order = await Order.create({
    user: userId,
    itemType,
    quantity,
    totalAmount,
    deliveryAddress,
    paymentRef: reference,
    status: "paid",
  });

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
export const getAllOrdersForUser = async (req:any, res:Response) => {
  try {
    const userId = req.user.id;
    const orders = await Order.find({ user: userId }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
};

export const getAllOrders = async (req: any, res: Response) => {
  try {
    // Optional: restrict non-admins
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Unauthorized access" });
    }

    const orders = await Order.find()
      .populate("user", "name email")
      .sort({ createdAt: -1 });

    res.status(200).json(orders);
  } catch (err) {
    console.error("Error fetching all orders:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
};

// PATCH /orders/:id/status - Mark order status
export const updateOrderStatus = async (req:any, res:Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["pending", "paid", "shipped", "delivered"].includes(status)) {
      return res.status(400).json({ error: "Invalid order status" });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({
      message: `Order marked as ${status}`,
      order: updatedOrder,
    });
  } catch (err) {
    console.error("Error updating order:", err);
    res.status(500).json({ error: "Failed to update order" });
  }
};

// DELETE /orders/:id - Delete an order (optional)
export const deleteOrder = async (req:any, res:Response) => {
  try {
    const { id } = req.params;
    const deleted = await Order.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: "Order not found" });
    res.json({ message: "Order deleted successfully" });
  } catch (err) {
    console.error("Error deleting order:", err);
    res.status(500).json({ error: "Failed to delete order" });
  }
};