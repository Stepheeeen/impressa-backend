import { HttpError } from "../middleware/errorHandler";
import type { IRewardSettings } from "../models/RewardSettings";
import { AppliedCoupon, applyCoupon } from "./coupons";
import { PricedCart, priceCart, toNaira } from "./pricing";
import { getRewardSettings } from "./rewardSettings";
import { getAvailableCreditKobo } from "./wallet";

// Paystack won't charge tiny amounts, so a card payment is never less than ₦100.
export const MIN_CARD_CHARGE_KOBO = 10_000;

export type CheckoutQuote = {
  priced: PricedCart;
  subtotalKobo: number;
  deliveryFeeKobo: number;
  discountKobo: number;
  coupon: AppliedCoupon | null;
  couponError: string | null;
  walletBalanceKobo: number;
  walletAppliedKobo: number;
  totalKobo: number;
  cardKobo: number;
};

function walletLimitKobo(settings: IRewardSettings, itemsKobo: number, totalKobo: number) {
  switch (settings.walletUsageMode) {
    case "items-only":
      return itemsKobo;
    case "percent-of-items":
      return Math.floor((itemsKobo * settings.walletUsagePercent) / 100);
    default:
      return totalKobo;
  }
}

// Prices the saved cart with an optional coupon and wallet credit. Used for both the quote and the real checkout.
export async function quoteCheckout({
  userId,
  couponCode,
  useWallet,
}: {
  userId: string;
  couponCode?: string | null;
  useWallet?: boolean;
}): Promise<CheckoutQuote> {
  const [priced, settings] = await Promise.all([priceCart(userId), getRewardSettings()]);
  const subtotalKobo = priced.subtotalKobo;

  let coupon: AppliedCoupon | null = null;
  let couponError: string | null = null;
  if (couponCode?.trim()) {
    if (!settings.couponsEnabled) {
      couponError = "Coupons aren't available right now.";
    } else {
      try {
        coupon = await applyCoupon({ code: couponCode, userId, subtotalKobo });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        couponError = err.message;
      }
    }
  }

  const discountKobo = coupon?.discountKobo ?? 0;
  const itemsKobo = subtotalKobo - discountKobo;
  const totalKobo = itemsKobo + priced.deliveryFeeKobo;

  const walletBalanceKobo = settings.walletEnabled ? await getAvailableCreditKobo(userId) : 0;
  let walletAppliedKobo = useWallet ? Math.min(walletBalanceKobo, walletLimitKobo(settings, itemsKobo, totalKobo)) : 0;

  const remainderKobo = totalKobo - walletAppliedKobo;
  if (remainderKobo > 0 && remainderKobo < MIN_CARD_CHARGE_KOBO) {
    walletAppliedKobo = Math.max(0, totalKobo - MIN_CARD_CHARGE_KOBO);
  }

  return {
    priced,
    subtotalKobo,
    deliveryFeeKobo: priced.deliveryFeeKobo,
    discountKobo,
    coupon,
    couponError,
    walletBalanceKobo,
    walletAppliedKobo,
    totalKobo,
    cardKobo: totalKobo - walletAppliedKobo,
  };
}

export function toQuoteResponse(quote: CheckoutQuote) {
  return {
    subtotal: toNaira(quote.subtotalKobo),
    deliveryFee: toNaira(quote.deliveryFeeKobo),
    discount: toNaira(quote.discountKobo),
    coupon: quote.coupon ? { code: quote.coupon.code, description: quote.coupon.description } : null,
    couponError: quote.couponError,
    walletBalance: toNaira(quote.walletBalanceKobo),
    walletApplied: toNaira(quote.walletAppliedKobo),
    total: toNaira(quote.totalKobo),
    cardAmount: toNaira(quote.cardKobo),
    itemCount: quote.priced.itemCount,
    hasUnavailableItems: quote.priced.hasUnavailable,
    sellers: quote.priced.sellers.map((seller) => ({
      merchantId: seller.merchantId,
      name: seller.name,
      deliveryFee: toNaira(seller.deliveryFeeKobo),
      itemsSubtotal: toNaira(seller.itemsSubtotalKobo),
    })),
  };
}
