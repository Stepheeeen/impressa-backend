import { Request, Response } from "express";
import Cart from "../models/Cart";

// ✅ Helper: Get or create cart for user
const getOrCreateCart = async (userId: string) => {
  let cart = await Cart.findOne({ user: userId });
  if (!cart) cart = await Cart.create({ user: userId, items: [] });
  return cart;
};

// ✅ Add item to cart (with merge logic)
export const addToCart = async (req: any, res: Response) => {
  try {
    const userId = req.user.id;
    const { templateId, designId, itemType, quantity = 1, price, size, color, description } = req.body;

    const cart = await getOrCreateCart(userId);

    // ✅ Try to find existing matching item
    const existingItem = cart.items.find((item: any) =>
      item.templateId?.toString() === templateId &&
      item.designId?.toString() === designId &&
      item.itemType === itemType &&
      item.size === size &&
      item.color === color &&
      item.description === description
    );

    // ✅ Optional: validate stock & size availability when a template is provided
    if (templateId) {
      const ProductTemplate = (await import("../models/ProductTemplate")).default;
      const tpl = await ProductTemplate.findById(templateId).lean();
      if (!tpl) return res.status(404).json({ error: "Product template not found" });
      if (tpl.inStock === false) {
        return res.status(400).json({ error: "Product is currently out of stock" });
      }
      if (size && Array.isArray(tpl.sizes) && tpl.sizes.length > 0 && !tpl.sizes.includes(size)) {
        return res.status(400).json({ error: "Selected size is unavailable for this product" });
      }
    }

    if (existingItem) {
      // ✅ Update qty and price
      existingItem.quantity += quantity;
      if (price) existingItem.price = price; // Allow price update if needed
    } else {
      // ✅ Create new item
      cart.items.push({
        templateId,
        designId,
        itemType,
        size,
        quantity,
        price,
        color,
        description,
      });
    }

    await cart.save();

    res.status(200).json({ message: "Cart updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add to cart" });
  }
};


// ✅ Get user's cart
export const getCart = async (req: any, res: Response) => {
  try {
    const userId = req.user.id;

    const cart = await getOrCreateCart(userId);

    const populated = await Cart.findById(cart._id)
      .populate({
        path: "items.templateId",
        model: "ProductTemplate",
        select: "title imageUrls price sizes colors inStock"
      })
      .populate({
        path: "items.designId",
        model: "Design",
        select: "title imageUrl"
      })
      .lean();

    const items = (populated?.items ?? []).map((item: any) => {
      const product = item.templateId || {};
      const design = item.designId || {};

      const unitPrice = item.price ?? product.price ?? 0;
      const quantity = item.quantity ?? 1;

      return {
        id: item._id,
        title: product.title || design.title || "Untitled",
        imageUrl: (Array.isArray(product.imageUrls) ? product.imageUrls[0] : product.imageUrl) || design.imageUrl || null,
        inStock: product.inStock ?? true,
        size: item.size ?? null,
        availableSizes: Array.isArray(product.sizes) ? product.sizes : [],
        quantity,
        unitPrice,
        itemTotal: +(unitPrice * quantity).toFixed(2),
        color: item.color || null,
        description: item.description || null
      };
    });

    const subtotal = items.reduce((sum, i) => sum + i.itemTotal, 0);

    res.json({
      items,
      subtotal: +subtotal.toFixed(2),
      total: subtotal,
      itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    });
  } catch (err) {
    console.error(err);
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

// ✅ Update item quantity
export const updateCartQuantity = async (req: any, res: Response) => {
  try {
    const userId = req.user.id;
    const { id: itemId, quantity } = req.body;

    if (!itemId) {
      return res.status(400).json({ error: "Item ID is required" });
    }

    if (quantity < 1) {
      return res.status(400).json({ error: "Quantity must be at least 1" });
    }

    const cart = await getOrCreateCart(userId);

    // ✅ Find the item
    const item = cart.items.find((i: any) => i._id.toString() === itemId);

    if (!item) {
      return res.status(404).json({ error: "Item not found in cart" });
    }

    // ✅ Update quantity
    item.quantity = quantity;

    await cart.save();

    // ✅ Return updated cart in same format as getCart
    const populated = await Cart.findById(cart._id)
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
      .lean();

    const items = (populated?.items ?? []).map((item: any) => {
      const product = item.templateId || {};
      const design = item.designId || {};

      const unitPrice = item.price ?? product.price ?? 0;
      const qty = item.quantity ?? 1;

      return {
        id: item._id,
        title: product.title || design.title || "Untitled",
        imageUrl: (Array.isArray(product.imageUrls) ? product.imageUrls[0] : product.imageUrl) || design.imageUrl || null,
        inStock: product.inStock ?? true,
        size: item.size ?? null,
        availableSizes: Array.isArray(product.sizes) ? product.sizes : [],
        quantity: qty,
        unitPrice,
        itemTotal: +(unitPrice * qty).toFixed(2),
        color: item.color || null,
        description: item.description || null
      };
    });

    const subtotal = items.reduce((sum, i) => sum + i.itemTotal, 0);

    res.json({
      message: "Quantity updated",
      items,
      subtotal: +subtotal.toFixed(2),
      total: subtotal,
      itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update quantity" });
  }
};
