import mongoose, { Schema, Document } from "mongoose";

export const PAYOUT_RECORD_STATUSES = ["processing", "paid", "failed"] as const;
export type PayoutRecordStatus = (typeof PAYOUT_RECORD_STATUSES)[number];

// One Paystack transfer to a merchant, covering every parcel that became due together.
export interface IPayout extends Document {
  merchant: mongoose.Types.ObjectId;
  fulfilments: mongoose.Types.ObjectId[];
  amountKobo: number;
  // Reused on every attempt so Paystack never sends the same payout twice.
  reference: string;
  recipientCode: string;
  transferCode?: string | null;
  status: PayoutRecordStatus;
  failureReason: string;
  attempts: number;
  lastAttemptAt?: Date | null;
  paidAt?: Date | null;
}

const PayoutSchema = new Schema(
  {
    merchant: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    fulfilments: { type: [{ type: Schema.Types.ObjectId, ref: "Fulfilment" }], default: [] },
    amountKobo: { type: Number, required: true, min: 0 },
    reference: { type: String, required: true, unique: true },
    recipientCode: { type: String, required: true },
    transferCode: { type: String, default: null },
    status: { type: String, enum: PAYOUT_RECORD_STATUSES, default: "processing" },
    failureReason: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

PayoutSchema.index({ status: 1, lastAttemptAt: 1 });

export default mongoose.model<IPayout>("Payout", PayoutSchema);
