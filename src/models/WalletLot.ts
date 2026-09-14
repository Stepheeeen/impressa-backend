import mongoose, { Schema, Document } from "mongoose";

export const CREDIT_SOURCES = ["cashback", "check-in", "scratch-card", "adjustment", "refund"] as const;
export type CreditSource = (typeof CREDIT_SOURCES)[number];

// One credit added to a wallet. Spending draws down the lots that expire soonest.
export interface IWalletLot extends Document {
  user: mongoose.Types.ObjectId;
  source: CreditSource;
  amountKobo: number;
  remainingKobo: number;
  expiresAt: Date;
  reference?: string;
  reminderSentAt?: Date | null;
}

const WalletLotSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    source: { type: String, enum: CREDIT_SOURCES, required: true },
    amountKobo: { type: Number, required: true, min: 1 },
    remainingKobo: { type: Number, required: true, min: 0 },
    expiresAt: { type: Date, required: true },
    reference: { type: String },
    reminderSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

WalletLotSchema.index({ user: 1, expiresAt: 1 });
WalletLotSchema.index({ expiresAt: 1, remainingKobo: 1 });

export default mongoose.model<IWalletLot>("WalletLot", WalletLotSchema);
