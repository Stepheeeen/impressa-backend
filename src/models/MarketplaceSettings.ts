import mongoose, { Schema, Document } from "mongoose";

export interface IMarketplaceSettings extends Document {
  key: "marketplace";
  defaultCommissionPercent: number;
  returnWindowDays: number;
  merchantResponseHours: number;
  // Off until Paystack Transfers is set up (transfers enabled, OTP off, enough balance).
  payoutsEnabled: boolean;
}

const MarketplaceSettingsSchema = new Schema(
  {
    key: { type: String, default: "marketplace", unique: true },
    defaultCommissionPercent: { type: Number, default: 10 },
    returnWindowDays: { type: Number, default: 7 },
    merchantResponseHours: { type: Number, default: 48 },
    payoutsEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model<IMarketplaceSettings>("MarketplaceSettings", MarketplaceSettingsSchema);
