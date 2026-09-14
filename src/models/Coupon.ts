import mongoose, { Schema, Document } from "mongoose";

export const COUPON_TYPES = ["percent", "fixed"] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

// Discounts apply to items only, never to delivery.
export interface ICoupon extends Document {
  code: string; // stored uppercase
  description?: string;
  type: CouponType;
  percentOff?: number | null;
  amountOffKobo?: number | null;
  maxDiscountKobo?: number | null;
  minSubtotalKobo: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  usageLimit?: number | null; // null means unlimited
  perCustomerLimit: number;
  timesUsed: number;
  active: boolean;
}

const CouponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: "" },
    type: { type: String, enum: COUPON_TYPES, required: true },
    percentOff: { type: Number, default: null },
    amountOffKobo: { type: Number, default: null },
    maxDiscountKobo: { type: Number, default: null },
    minSubtotalKobo: { type: Number, default: 0 },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    usageLimit: { type: Number, default: null },
    perCustomerLimit: { type: Number, default: 1 },
    timesUsed: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model<ICoupon>("Coupon", CouponSchema);
