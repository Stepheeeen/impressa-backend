import { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import Cart from "../models/Cart";
import GroupBuy from "../models/GroupBuy";
import ProductTemplate from "../models/ProductTemplate";
import { ensureStock, findBuyableProduct, quantityField } from "../services/cartItems";
import { MAX_ITEM_QUANTITY, priceCart, toCartResponse } from "../services/pricing";

// Any price, itemType or designId sent by the client is stripped here.
const AddToCartSchema = z.object({
  templateId: z.string({ error: "Choose a product to add." }).regex(/^[a-f0-9]{24}$/i, "Choose a product to add."),
  quantity: quantityField.default(1),
  // The website sends null when a product has no sizes or colours.
  size: z.string().trim().max(20).nullish(),
  color: z.string().trim().max(40).nullish(),
  // Buying through a group buy someone shared.
  groupBuyCode: z.string().trim().max(20).nullish(),
});

const UpdateQuantitySchema = z.object({
  id: z.string({ error: "Item not found in cart." }).regex(/^[a-f0-9]{24}$/i, "Item not found in cart."),
  quantity: quantityField,
});

// POST /api/cart/add
export const addToCart = async (req: Request, res: Response) => {
  if (req.body?.designId) throw new HttpError(400, "Custom designs can't be ordered yet.");

  const input = AddToCartSchema.parse(req.body ?? {});
  const size = input.size || undefined;
  const color = input.color || undefined;

  const product = await findBuyableProduct({ templateId: input.templateId, size, color });

  let group = null;
  if (input.groupBuyCode) {
    group = await GroupBuy.findOne({ code: input.groupBuyCode }).select("product status expiresAt").lean();
    if (!group || String(group.product) !== input.templateId) throw new HttpError(404, "Group buy not found.");
    if (group.status !== "open" || group.expiresAt <= new Date()) throw new HttpError(409, "This group buy has ended.");
  }

  const userId = req.user!.id;
  const cart = (await Cart.findOne({ user: userId })) ?? new Cart({ user: userId, items: [] });

  // The same product bought through a group is kept as its own line.
  const existing = cart.items.find(
    (item) =>
      item.templateId?.toString() === input.templateId &&
      (item.size ?? undefined) === size &&
      (item.color ?? undefined) === color &&
      item.groupBuy?.toString() === (group ? String(group._id) : undefined)
  );

  ensureStock(product, Math.min((existing?.quantity ?? 0) + input.quantity, MAX_ITEM_QUANTITY));

  // The stored price is only a record of what was shown; checkout always reprices from the product.
  if (existing) {
    existing.quantity = Math.min(existing.quantity + input.quantity, MAX_ITEM_QUANTITY);
    existing.price = product.price;
  } else {
    cart.items.push({
      templateId: product._id,
      itemType: product.itemType,
      quantity: input.quantity,
      price: product.price,
      size,
      color,
      groupBuy: group?._id,
    });
  }

  await cart.save();
  res.json({ message: "Cart updated" });
};

// GET /api/cart
export const getCart = async (req: Request, res: Response) => {
  res.json(toCartResponse(await priceCart(req.user!.id)));
};

// DELETE /api/cart/remove/:itemId
export const removeFromCart = async (req: Request, res: Response) => {
  await Cart.updateOne({ user: req.user!.id }, { $pull: { items: { _id: req.params.itemId } } });
  res.json({ message: "Item removed" });
};

// DELETE /api/cart/clear
export const clearCart = async (req: Request, res: Response) => {
  await Cart.updateOne({ user: req.user!.id }, { $set: { items: [] } });
  res.json({ message: "Cart cleared" });
};

// POST /api/cart/update
export const updateCartQuantity = async (req: Request, res: Response) => {
  const { id, quantity } = UpdateQuantitySchema.parse(req.body ?? {});
  const userId = req.user!.id;

  const cart = await Cart.findOne({ user: userId, "items._id": id }, { "items.$": 1 }).lean();
  const templateId = cart?.items?.[0]?.templateId;
  if (templateId) {
    const product = await ProductTemplate.findById(templateId).select("stockQuantity").lean();
    if (product) ensureStock(product, quantity);
  }

  const result = await Cart.updateOne({ user: userId, "items._id": id }, { $set: { "items.$.quantity": quantity } });
  if (result.matchedCount === 0) throw new HttpError(404, "Item not found in cart.");

  res.json({ message: "Quantity updated", ...toCartResponse(await priceCart(userId)) });
};
