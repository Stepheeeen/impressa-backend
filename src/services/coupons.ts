import { HttpError } from "../middleware/errorHandler";
import Coupon from "../models/Coupon";
import CouponRedemption from "../models/CouponRedemption";
import { formatNaira } from "./pricing";

export type AppliedCoupon = {
  code: string;
  description: string;
  discountKobo: number;
};

// Checks a coupon for this customer and cart. Throws HttpError(400) with a message customers can act on.
export async function applyCoupon({ code, userId, subtotalKobo }: { code: string; userId: string; subtotalKobo: number }) {
  const coupon = await Coupon.findOne({ code: code.trim().toUpperCase() });
  const now = new Date();

  if (!coupon || !coupon.active || (coupon.startsAt && coupon.startsAt > now)) {
    throw new HttpError(400, "That coupon code isn't valid.");
  }
  if (coupon.endsAt && coupon.endsAt <= now) {
    throw new HttpError(400, "That coupon has expired.");
  }
  if (subtotalKobo < coupon.minSubtotalKobo) {
    throw new HttpError(400, `Spend at least ${formatNaira(coupon.minSubtotalKobo)} on items to use this coupon.`);
  }
  if (coupon.usageLimit != null && coupon.timesUsed >= coupon.usageLimit) {
    throw new HttpError(400, "That coupon has been fully used.");
  }
  if ((await CouponRedemption.countDocuments({ coupon: coupon._id, user: userId })) >= coupon.perCustomerLimit) {
    throw new HttpError(400, "You've already used this coupon.");
  }

  const discount =
    coupon.type === "percent"
      ? Math.floor((subtotalKobo * (coupon.percentOff ?? 0)) / 100)
      : coupon.amountOffKobo ?? 0;
  const capped = coupon.maxDiscountKobo != null ? Math.min(discount, coupon.maxDiscountKobo) : discount;

  return {
    code: coupon.code,
    description: coupon.description ?? "",
    discountKobo: Math.min(capped, subtotalKobo),
  } satisfies AppliedCoupon;
}

// Records a coupon use for a paid order. Safe to repeat for the same payment.
export async function redeemCoupon(input: {
  couponCode: string;
  userId: string;
  orderId: string;
  reference: string;
  discountKobo: number;
}) {
  const coupon = await Coupon.findOne({ code: input.couponCode });
  if (!coupon) return;

  try {
    await CouponRedemption.create({
      coupon: coupon._id,
      user: input.userId,
      order: input.orderId,
      reference: input.reference,
      discountKobo: input.discountKobo,
    });
  } catch (err: any) {
    if (err?.code === 11000) return;
    throw err;
  }

  // Counted once paid, so a coupon can go slightly over its limit when several checkouts were already open.
  await Coupon.updateOne({ _id: coupon._id }, { $inc: { timesUsed: 1 } });
}
