import Cart from "../models/Cart";
import Merchant from "../models/Merchant";

// Money is handled in kobo (integers) and converted to naira only at the edges.
export const DELIVERY_FEE_KOBO = 150_000; // ₦1,500 delivery for products Impressa sells itself
export const MAX_ITEM_QUANTITY = 99;
export const IMPRESSA_SELLER_NAME = "Impressa";

export const toKobo = (naira: number) => Math.round(naira * 100);
export const toNaira = (kobo: number) => kobo / 100;
export const formatNaira = (kobo: number) => `₦${toNaira(kobo).toLocaleString("en-NG")}`;

export type UnavailableReason = "out-of-stock" | "not-enough-stock" | "unavailable" | "group-ended";

export type PricedLine = {
  id: string;
  templateId: string | null;
  merchantId: string | null;
  sellerName: string;
  title: string;
  imageUrl: string | null;
  itemType: string;
  size: string | null;
  color: string | null;
  description: string | null;
  availableSizes: string[];
  quantity: number;
  // Units left when stock is tracked, otherwise null.
  availableQuantity: number | null;
  unitPriceKobo: number;
  available: boolean;
  unavailableReason: UnavailableReason | null;
  // Set when the item is being bought through a group buy.
  groupBuy: { id: string; code: string; endsAt: Date } | null;
};

// Each seller ships their own parcel and charges their own delivery fee.
export type SellerGroup = {
  merchantId: string | null;
  name: string;
  deliveryFeeKobo: number;
  itemsSubtotalKobo: number;
  itemCount: number;
};

export type PricedCart = {
  lines: PricedLine[];
  sellers: SellerGroup[];
  subtotalKobo: number;
  deliveryFeeKobo: number;
  itemCount: number;
  hasUnavailable: boolean;
};

// Prices every line from the product's current price and stock. Prices stored on the cart or sent by clients are never used.
export async function priceCart(userId: string): Promise<PricedCart> {
  const cart = await Cart.findOne({ user: userId })
    .populate({
      path: "items.templateId",
      model: "ProductTemplate",
      select: "title imageUrls price sizes inStock itemType merchant stockQuantity hidden sellerActive",
    })
    .populate({ path: "items.designId", model: "Design", select: "title imageUrl" })
    .populate({ path: "items.groupBuy", model: "GroupBuy", select: "code status expiresAt" })
    .lean();

  const items: any[] = cart?.items ?? [];
  const merchantIds = [
    ...new Set(items.map((item) => item.templateId?.merchant).filter(Boolean).map(String)),
  ];
  const merchants = new Map(
    (await Merchant.find({ _id: { $in: merchantIds } }).select("businessName deliveryFeeKobo status").lean()).map(
      (merchant) => [String(merchant._id), merchant]
    )
  );

  const lines = items.map((item): PricedLine => {
    const product = item.templateId && typeof item.templateId === "object" ? item.templateId : null;
    const design = item.designId && typeof item.designId === "object" ? item.designId : null;
    const merchantId = product?.merchant ? String(product.merchant) : null;
    const merchant = merchantId ? merchants.get(merchantId) : null;
    const price = Number(product?.price);
    const quantity = item.quantity ?? 1;
    const stock = typeof product?.stockQuantity === "number" ? product.stockQuantity : null;

    const listed =
      Boolean(product) &&
      !item.designId &&
      price > 0 &&
      !product.hidden &&
      product.sellerActive !== false &&
      (!merchantId || merchant?.status === "approved");

    const group = item.groupBuy && typeof item.groupBuy === "object" ? item.groupBuy : null;
    const groupEnded = Boolean(group) && (group.status !== "open" || new Date(group.expiresAt) <= new Date());

    let unavailableReason: UnavailableReason | null = null;
    if (!listed) unavailableReason = "unavailable";
    else if (groupEnded) unavailableReason = "group-ended";
    else if (product.inStock === false || stock === 0) unavailableReason = "out-of-stock";
    else if (stock !== null && stock < quantity) unavailableReason = "not-enough-stock";

    return {
      id: String(item._id),
      templateId: product ? String(product._id) : null,
      merchantId,
      sellerName: merchant?.businessName ?? IMPRESSA_SELLER_NAME,
      title: product?.title ?? design?.title ?? "Unavailable item",
      imageUrl: product?.imageUrls?.[0] ?? design?.imageUrl ?? null,
      itemType: product?.itemType ?? item.itemType ?? "product",
      size: item.size ?? null,
      color: item.color ?? null,
      description: item.description ?? null,
      availableSizes: Array.isArray(product?.sizes) ? product.sizes : [],
      quantity,
      availableQuantity: stock,
      unitPriceKobo: unavailableReason === null ? toKobo(price) : 0,
      available: unavailableReason === null,
      unavailableReason,
      groupBuy: group ? { id: String(group._id), code: group.code, endsAt: group.expiresAt } : null,
    };
  });

  const sellers = new Map<string, SellerGroup>();
  for (const line of lines.filter((l) => l.available)) {
    const key = line.merchantId ?? "impressa";
    const group = sellers.get(key) ?? {
      merchantId: line.merchantId,
      name: line.sellerName,
      deliveryFeeKobo: line.merchantId ? merchants.get(line.merchantId)?.deliveryFeeKobo ?? 0 : DELIVERY_FEE_KOBO,
      itemsSubtotalKobo: 0,
      itemCount: 0,
    };
    group.itemsSubtotalKobo += line.unitPriceKobo * line.quantity;
    group.itemCount += line.quantity;
    sellers.set(key, group);
  }
  const sellerGroups = [...sellers.values()];

  return {
    lines,
    sellers: sellerGroups,
    subtotalKobo: sellerGroups.reduce((sum, seller) => sum + seller.itemsSubtotalKobo, 0),
    deliveryFeeKobo: sellerGroups.reduce((sum, seller) => sum + seller.deliveryFeeKobo, 0),
    itemCount: sellerGroups.reduce((sum, seller) => sum + seller.itemCount, 0),
    hasUnavailable: lines.some((line) => !line.available),
  };
}

// Same shape the website and app already read from GET /cart, plus sellers and stock details.
export function toCartResponse(priced: PricedCart) {
  return {
    items: priced.lines.map((line) => ({
      id: line.id,
      title: line.title,
      imageUrl: line.imageUrl,
      inStock: line.available,
      unavailableReason: line.unavailableReason,
      availableQuantity: line.availableQuantity,
      sellerName: line.sellerName,
      size: line.size,
      availableSizes: line.availableSizes,
      quantity: line.quantity,
      unitPrice: toNaira(line.unitPriceKobo),
      itemTotal: toNaira(line.unitPriceKobo * line.quantity),
      color: line.color,
      description: line.description,
      groupBuy: line.groupBuy ? { code: line.groupBuy.code, endsAt: line.groupBuy.endsAt } : null,
    })),
    sellers: priced.sellers.map((seller) => ({
      merchantId: seller.merchantId,
      name: seller.name,
      deliveryFee: toNaira(seller.deliveryFeeKobo),
      itemsSubtotal: toNaira(seller.itemsSubtotalKobo),
    })),
    subtotal: toNaira(priced.subtotalKobo),
    total: toNaira(priced.subtotalKobo),
    deliveryFee: toNaira(priced.deliveryFeeKobo),
    itemCount: priced.itemCount,
  };
}
