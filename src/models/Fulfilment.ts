import mongoose, { Schema, Document } from "mongoose";
import { TRACKING_STATUSES, TrackingStatus } from "./Order";

export const FULFILMENT_STATUSES = ["paid", "shipped", "delivered", "cancelled"] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

export const PAYOUT_STATUSES = ["not-applicable", "pending", "held", "processing", "paid", "failed"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export type FulfilmentItem = {
  templateId: mongoose.Types.ObjectId | null;
  title: string;
  quantity: number;
  unitPriceKobo: number;
  size?: string;
  color?: string;
  imageUrl?: string;
  // Another customer bought the last units before this payment completed.
  oversold?: boolean;
  returnedQuantity?: number;
};

// One seller's part of an order: the parcel they ship, and what they're paid for it.
// merchant is null for products Impressa sells itself.
export interface IFulfilment extends Document {
  order: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  merchant: mongoose.Types.ObjectId | null;
  sellerName: string;
  items: FulfilmentItem[];
  itemsSubtotalKobo: number;
  deliveryFeeKobo: number;
  // Fixed when the order is placed, so later rate changes don't affect it.
  commissionPercent: number;
  commissionKobo: number;
  payoutKobo: number;
  status: FulfilmentStatus;
  statusHistory: { status: FulfilmentStatus; at: Date }[];
  tracking?: { status?: TrackingStatus; code?: string; updatedAt?: Date };
  deliveredAt?: Date | null;
  stockReserved: boolean;
  needsAttention: boolean;
  payout: { status: PayoutStatus; payoutId?: mongoose.Types.ObjectId | null; paidAt?: Date | null };
  // Value of items refunded through returns; they no longer count toward the payout.
  refundedItemsKobo: number;
  cancelledAt?: Date | null;
  cancelReason?: string;
}

const FulfilmentSchema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    merchant: { type: Schema.Types.ObjectId, ref: "Merchant", default: null },
    sellerName: { type: String, required: true },
    items: {
      type: [
        {
          _id: false,
          templateId: { type: Schema.Types.ObjectId, ref: "ProductTemplate", default: null },
          title: String,
          quantity: Number,
          unitPriceKobo: Number,
          size: String,
          color: String,
          imageUrl: String,
          oversold: Boolean,
          returnedQuantity: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    itemsSubtotalKobo: { type: Number, required: true },
    deliveryFeeKobo: { type: Number, required: true },
    commissionPercent: { type: Number, required: true },
    commissionKobo: { type: Number, required: true },
    payoutKobo: { type: Number, required: true },
    status: { type: String, enum: FULFILMENT_STATUSES, default: "paid" },
    statusHistory: {
      type: [{ _id: false, status: { type: String, enum: FULFILMENT_STATUSES }, at: Date }],
      default: [],
    },
    tracking: {
      status: { type: String, enum: TRACKING_STATUSES },
      code: { type: String },
      updatedAt: { type: Date },
    },
    deliveredAt: { type: Date, default: null },
    stockReserved: { type: Boolean, default: false },
    needsAttention: { type: Boolean, default: false },
    payout: {
      status: { type: String, enum: PAYOUT_STATUSES, default: "pending" },
      payoutId: { type: Schema.Types.ObjectId, ref: "Payout", default: null },
      paidAt: { type: Date, default: null },
    },
    refundedItemsKobo: { type: Number, default: 0 },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: "" },
  },
  { timestamps: true }
);

// One fulfilment per seller per order, however many times payment verification runs.
FulfilmentSchema.index({ order: 1, merchant: 1 }, { unique: true });
FulfilmentSchema.index({ merchant: 1, status: 1, createdAt: -1 });
FulfilmentSchema.index({ "payout.status": 1, deliveredAt: 1 });

export default mongoose.model<IFulfilment>("Fulfilment", FulfilmentSchema);
