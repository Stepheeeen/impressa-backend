import Cart from "../models/Cart";

// Money is handled in kobo (integers) and converted to naira only at the edges.
export const DELIVERY_FEE_KOBO = 150_000; // ₦1,500 flat delivery, as shown on the website and app
export const MAX_ITEM_QUANTITY = 99;

export const toKobo = (naira: number) => Math.round(naira * 100);
export const toNaira = (kobo: number) => kobo / 100;
export const formatNaira = (kobo: number) => `₦${toNaira(kobo).toLocaleString("en-NG")}`;

export type PricedLine = {
  id: string;
  templateId: string | null;
  title: string;
  imageUrl: string | null;
  itemType: string;
  size: string | null;
  color: string | null;
  description: string | null;
  availableSizes: string[];
  quantity: number;
  unitPriceKobo: number;
  // False when the product was deleted, is out of stock, has no price, or the item is a custom design.
  available: boolean;
};

export type PricedCart = {
  lines: PricedLine[];
  subtotalKobo: number;
  itemCount: number;
  hasUnavailable: boolean;
};

// Prices every line from the product's current price. Prices stored on the cart or sent by clients are never used.
export async function priceCart(userId: string): Promise<PricedCart> {
  const cart = await Cart.findOne({ user: userId })
    .populate({ path: "items.templateId", model: "ProductTemplate", select: "title imageUrls price sizes inStock itemType" })
    .populate({ path: "items.designId", model: "Design", select: "title imageUrl" })
    .lean();

  const lines = (cart?.items ?? []).map((item: any): PricedLine => {
    const product = item.templateId && typeof item.templateId === "object" ? item.templateId : null;
    const design = item.designId && typeof item.designId === "object" ? item.designId : null;
    const price = Number(product?.price);
    const available = Boolean(product) && !item.designId && product.inStock !== false && price > 0;

    return {
      id: String(item._id),
      templateId: product ? String(product._id) : null,
      title: product?.title ?? design?.title ?? "Unavailable item",
      imageUrl: product?.imageUrls?.[0] ?? design?.imageUrl ?? null,
      itemType: product?.itemType ?? item.itemType ?? "product",
      size: item.size ?? null,
      color: item.color ?? null,
      description: item.description ?? null,
      availableSizes: Array.isArray(product?.sizes) ? product.sizes : [],
      quantity: item.quantity ?? 1,
      unitPriceKobo: available ? toKobo(price) : 0,
      available,
    };
  });

  const availableLines = lines.filter((line) => line.available);

  return {
    lines,
    subtotalKobo: availableLines.reduce((sum, line) => sum + line.unitPriceKobo * line.quantity, 0),
    itemCount: availableLines.reduce((sum, line) => sum + line.quantity, 0),
    hasUnavailable: lines.some((line) => !line.available),
  };
}

// Same shape the website and app already read from GET /cart, plus the delivery fee.
export function toCartResponse(priced: PricedCart) {
  return {
    items: priced.lines.map((line) => ({
      id: line.id,
      title: line.title,
      imageUrl: line.imageUrl,
      inStock: line.available,
      size: line.size,
      availableSizes: line.availableSizes,
      quantity: line.quantity,
      unitPrice: toNaira(line.unitPriceKobo),
      itemTotal: toNaira(line.unitPriceKobo * line.quantity),
      color: line.color,
      description: line.description,
    })),
    subtotal: toNaira(priced.subtotalKobo),
    total: toNaira(priced.subtotalKobo),
    deliveryFee: toNaira(DELIVERY_FEE_KOBO),
    itemCount: priced.itemCount,
  };
}
