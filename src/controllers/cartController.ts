import { Request, Response } from "express";
import Cart from "../models/Cart";

// ✅ Helper: Get or create cart for user
const getOrCreateCart = async (userId: string) => {
  let cart = await Cart.findOne({ user: userId });
  if (!cart) cart = await Cart.create({ user: userId, items: [] });
  return cart;
};

// ✅ Add item to cart
export const addToCart = async (req: any, res: Response) => {
  try {
    const userId = req.user.id;
    const { templateId, designId, itemType, quantity, price } = req.body;

    const cart = await getOrCreateCart(userId);

    cart.items.push({
      templateId,
      designId,
      itemType,
      quantity,
      price,
    });

    await cart.save();

    res.status(201).json(cart);
  } catch (err) {
    res.status(500).json({ error: "Failed to add to cart" });
  }
};

// ✅ Get user's cart
export const getCart = async (req: any, res: Response) => {
  try {
    const userId = req.user.id;

    const cart = await getOrCreateCart(userId);

    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch cart" });
  }
};

// ✅ Remove a single cart item
export const removeFromCart = async (req: any, res: Response) => {
  try {
    const userId = req.user.id;
    const itemId = req.params.itemId;

    const cart = await getOrCreateCart(userId);

    cart.items = cart.items.filter((item: any) => item._id.toString() !== itemId);

    await cart.save();

    res.json({ message: "Item removed", cart });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove item" });
  }
};

// ✅ Clear entire cart
export const clearCart = async (req: any, res: Response) => {
  try {
    const userId = req.user.id;

    const cart = await getOrCreateCart(userId);

    cart.items = [];
    await cart.save();

    res.json({ message: "Cart cleared" });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear cart" });
  }
};