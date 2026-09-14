import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import Merchant from "../models/Merchant";
import ProductTemplate, { IProductTemplate } from "../models/ProductTemplate";
import { MAX_ITEM_QUANTITY } from "./pricing";

export const quantityField = z.coerce
  .number({ error: "Quantity must be a number." })
  .int("Quantity must be a whole number.")
  .min(1, "Quantity must be at least 1.")
  .max(MAX_ITEM_QUANTITY, `You can add up to ${MAX_ITEM_QUANTITY} of an item.`);

// Hidden products, suspended sellers and unapproved merchants can't be bought.
async function ensureListed(product: Pick<IProductTemplate, "hidden" | "sellerActive" | "merchant"> | null) {
  const unavailable = new HttpError(404, "This product is no longer available.");
  if (!product || product.hidden || product.sellerActive === false) throw unavailable;
  if (product.merchant) {
    const merchant = await Merchant.findById(product.merchant).select("status").lean();
    if (merchant?.status !== "approved") throw unavailable;
  }
}

export function ensureStock(product: Pick<IProductTemplate, "stockQuantity">, quantity: number) {
  if (typeof product.stockQuantity !== "number" || product.stockQuantity >= quantity) return;
  throw new HttpError(
    400,
    product.stockQuantity === 0 ? "This product is out of stock." : `Only ${product.stockQuantity} left in stock.`
  );
}

// Checks a product can go in a cart (personal or shared) with these options, and returns it.
export async function findBuyableProduct({ templateId, size, color }: { templateId: string; size?: string; color?: string }) {
  const product = await ProductTemplate.findById(templateId).lean();
  await ensureListed(product);
  if (!product) throw new HttpError(404, "This product is no longer available.");
  if (product.inStock === false) throw new HttpError(400, "This product is out of stock.");
  if (!(Number(product.price) > 0)) throw new HttpError(400, "This product isn't available to buy yet.");
  if (size && product.sizes?.length && !product.sizes.includes(size)) {
    throw new HttpError(400, "That size isn't available for this product.");
  }
  if (color && product.colors?.length && !product.colors.includes(color)) {
    throw new HttpError(400, "That colour isn't available for this product.");
  }
  return product;
}
