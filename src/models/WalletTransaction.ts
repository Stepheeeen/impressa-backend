import mongoose, { Schema, Document } from "mongoose";

export const WALLET_TRANSACTION_KINDS = ["credit", "debit", "hold", "release", "expiry"] as const;
export type WalletTransactionKind = (typeof WALLET_TRANSACTION_KINDS)[number];

export type LotAllocation = { lot: mongoose.Types.ObjectId; amountKobo: number };

// The wallet ledger. Entries are only ever inserted, never changed. Positive amounts add to the balance,
// negative amounts remove from it, and for every customer the total always equals the lots' remaining credit.
export interface IWalletTransaction extends Document {
  user: mongoose.Types.ObjectId;
  kind: WalletTransactionKind;
  amountKobo: number;
  // A credit source (cashback, check-in, ...) or "checkout", "adjustment", "expiry".
  source: string;
  reference?: string;
  idempotencyKey?: string;
  allocations: LotAllocation[];
  // The admin who made a manual adjustment, and their reason.
  actor?: mongoose.Types.ObjectId;
  note?: string;
  createdAt: Date;
}

const WalletTransactionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: WALLET_TRANSACTION_KINDS, required: true },
    amountKobo: { type: Number, required: true },
    source: { type: String, required: true },
    reference: { type: String },
    idempotencyKey: { type: String, unique: true, sparse: true },
    allocations: {
      type: [{ _id: false, lot: { type: Schema.Types.ObjectId, ref: "WalletLot" }, amountKobo: Number }],
      default: [],
    },
    actor: { type: Schema.Types.ObjectId, ref: "User" },
    note: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

WalletTransactionSchema.index({ user: 1, createdAt: -1 });
WalletTransactionSchema.index({ kind: 1, source: 1, createdAt: 1 });

export default mongoose.model<IWalletTransaction>("WalletTransaction", WalletTransactionSchema);
