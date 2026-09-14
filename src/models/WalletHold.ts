import mongoose, { Schema, Document } from "mongoose";
import type { LotAllocation } from "./WalletTransaction";

export const HOLD_STATUSES = ["held", "committed", "released"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

// Wallet credit set aside while a customer pays the rest on Paystack, so it can't be spent twice.
export interface IWalletHold extends Document {
  user: mongoose.Types.ObjectId;
  reference: string; // the Paystack payment reference
  amountKobo: number;
  allocations: LotAllocation[];
  status: HoldStatus;
  expiresAt: Date;
}

const WalletHoldSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    reference: { type: String, required: true, unique: true },
    amountKobo: { type: Number, required: true, min: 1 },
    allocations: {
      type: [{ _id: false, lot: { type: Schema.Types.ObjectId, ref: "WalletLot" }, amountKobo: Number }],
      default: [],
    },
    status: { type: String, enum: HOLD_STATUSES, default: "held" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

WalletHoldSchema.index({ status: 1, expiresAt: 1 });

export default mongoose.model<IWalletHold>("WalletHold", WalletHoldSchema);
