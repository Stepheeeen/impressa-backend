import mongoose, { Schema, Document } from "mongoose";
import { NIGERIA_STATES } from "../constants/nigeria";

export const MERCHANT_STATUSES = ["pending", "approved", "rejected", "suspended"] as const;
export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];

export interface IMerchant extends Document {
  user: mongoose.Types.ObjectId;
  businessName: string;
  description: string;
  phone: string;
  email: string;
  state: string;
  address: string;
  cacNumber?: string;
  // A private Cloudinary file, only viewable through short-lived signed links.
  idDocument: { publicId: string; format: string };
  // Only the last 4 digits are kept; payouts go to the Paystack transfer recipient.
  bank: { bankCode: string; bankName: string; accountName: string; accountNumberLast4: string; recipientCode: string };
  deliveryFeeKobo: number;
  status: MerchantStatus;
  statusReason: string;
  reviewedBy?: mongoose.Types.ObjectId | null;
  reviewedAt?: Date | null;
  // Overrides the marketplace default when set.
  commissionPercent: number | null;
  ratingAverage: number;
  ratingCount: number;
}

const MerchantSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    businessName: { type: String, required: true },
    description: { type: String, default: "" },
    phone: { type: String, required: true },
    email: { type: String, required: true },
    state: { type: String, enum: NIGERIA_STATES, required: true },
    address: { type: String, required: true },
    cacNumber: { type: String, default: "" },
    idDocument: {
      publicId: { type: String, required: true },
      format: { type: String, required: true },
    },
    bank: {
      bankCode: { type: String, required: true },
      bankName: { type: String, required: true },
      accountName: { type: String, required: true },
      accountNumberLast4: { type: String, required: true },
      recipientCode: { type: String, required: true },
    },
    deliveryFeeKobo: { type: Number, required: true, min: 0 },
    status: { type: String, enum: MERCHANT_STATUSES, default: "pending", index: true },
    statusReason: { type: String, default: "" },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    commissionPercent: { type: Number, default: null },
    ratingAverage: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model<IMerchant>("Merchant", MerchantSchema);
