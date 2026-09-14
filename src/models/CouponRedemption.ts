import mongoose, { Schema, Document } from "mongoose";

export interface ICouponRedemption extends Document {
  coupon: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  order?: mongoose.Types.ObjectId;
  reference: string;
  discountKobo: number;
}

const CouponRedemptionSchema = new Schema(
  {
    coupon: { type: Schema.Types.ObjectId, ref: "Coupon", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order" },
    reference: { type: String, required: true },
    discountKobo: { type: Number, required: true },
  },
  { timestamps: true }
);

// One redemption per payment, however many times verify and the webhook run.
CouponRedemptionSchema.index({ coupon: 1, reference: 1 }, { unique: true });
CouponRedemptionSchema.index({ coupon: 1, user: 1 });

export default mongoose.model<ICouponRedemption>("CouponRedemption", CouponRedemptionSchema);
