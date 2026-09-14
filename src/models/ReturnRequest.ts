import mongoose, { Schema, Document } from "mongoose";

export const RETURN_REASONS = ["faulty", "wrong-item", "not-as-described", "changed-mind"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_STATUSES = ["requested", "rejected-by-merchant", "escalated", "refunded", "declined"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

// Statuses where the return is still being decided and the parcel's payout stays held.
export const OPEN_RETURN_STATUSES: ReturnStatus[] = ["requested", "rejected-by-merchant", "escalated"];

export interface IReturnRequest extends Document {
  fulfilment: mongoose.Types.ObjectId;
  order: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  merchant: mongoose.Types.ObjectId | null;
  items: { index: number; title: string; quantity: number; unitPriceKobo: number }[];
  itemsValueKobo: number;
  reason: ReturnReason;
  details: string;
  photoUrls: string[];
  refundTo: "wallet" | "card";
  returnShippingPaidBy: "merchant" | "customer";
  status: ReturnStatus;
  open: boolean;
  merchantRespondBy: Date;
  merchantNote: string;
  merchantRespondedAt?: Date | null;
  customerEscalateBy?: Date | null;
  customerNote: string;
  adminNote: string;
  decidedBy?: mongoose.Types.ObjectId | null;
  decidedAt?: Date | null;
  refund?: { amountKobo: number; cardKobo: number; walletKobo: number; completedAt: Date } | null;
}

const ReturnRequestSchema = new Schema(
  {
    fulfilment: { type: Schema.Types.ObjectId, ref: "Fulfilment", required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    merchant: { type: Schema.Types.ObjectId, ref: "Merchant", default: null },
    items: {
      type: [{ _id: false, index: Number, title: String, quantity: Number, unitPriceKobo: Number }],
      default: [],
    },
    itemsValueKobo: { type: Number, required: true },
    reason: { type: String, enum: RETURN_REASONS, required: true },
    details: { type: String, required: true },
    photoUrls: { type: [String], default: [] },
    refundTo: { type: String, enum: ["wallet", "card"], required: true },
    returnShippingPaidBy: { type: String, enum: ["merchant", "customer"], required: true },
    status: { type: String, enum: RETURN_STATUSES, default: "requested" },
    open: { type: Boolean, default: true },
    merchantRespondBy: { type: Date, required: true },
    merchantNote: { type: String, default: "" },
    merchantRespondedAt: { type: Date, default: null },
    customerEscalateBy: { type: Date, default: null },
    customerNote: { type: String, default: "" },
    adminNote: { type: String, default: "" },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    refund: {
      type: new Schema({ amountKobo: Number, cardKobo: Number, walletKobo: Number, completedAt: Date }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true }
);

// One open return per parcel at a time.
ReturnRequestSchema.index({ fulfilment: 1 }, { unique: true, partialFilterExpression: { open: true } });
ReturnRequestSchema.index({ merchant: 1, status: 1, createdAt: -1 });
ReturnRequestSchema.index({ user: 1, createdAt: -1 });
ReturnRequestSchema.index({ status: 1, merchantRespondBy: 1 });

export default mongoose.model<IReturnRequest>("ReturnRequest", ReturnRequestSchema);
