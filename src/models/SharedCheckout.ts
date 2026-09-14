import mongoose, { Document, Schema } from "mongoose";

export const PAYMENT_MODES = ["one-payer", "own-items", "split-evenly"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const SHARED_CHECKOUT_STATUSES = ["collecting", "completed", "cancelled"] as const;
export type SharedCheckoutStatus = (typeof SHARED_CHECKOUT_STATUSES)[number];

export type Share = {
  user: mongoose.Types.ObjectId;
  // What this person owes, and the items part of it (wallet limits are based on items).
  amountKobo: number;
  itemsKobo: number;
  status: "unpaid" | "paid";
  reference: string | null;
  cardKobo: number;
  walletKobo: number;
  paidAt: Date | null;
};

export type SharePayment = {
  reference: string;
  user: mongoose.Types.ObjectId;
  cardKobo: number;
  walletKobo: number;
  // "refunded" also covers payments that turned out not to be needed: a share already paid, or a checkout that ended.
  status: "pending" | "paid" | "refunded";
  createdAt: Date;
};

// Members of a shared cart paying for it. The order is placed once every share is paid.
export interface ISharedCheckout extends Document {
  sharedCart: mongoose.Types.ObjectId;
  owner: mongoose.Types.ObjectId;
  mode: PaymentMode;
  status: SharedCheckoutStatus;
  expiresAt: Date;
  // The order is built from this snapshot, at the prices shown when checkout started.
  metadata: Record<string, any>;
  totalKobo: number;
  shares: Share[];
  payments: SharePayment[];
  order: mongoose.Types.ObjectId | null;
  cancelReason: string;
  closedAt: Date | null;
}

const SharedCheckoutSchema = new Schema(
  {
    sharedCart: { type: Schema.Types.ObjectId, ref: "SharedCart", required: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    mode: { type: String, enum: PAYMENT_MODES, required: true },
    status: { type: String, enum: SHARED_CHECKOUT_STATUSES, default: "collecting" },
    expiresAt: { type: Date, required: true },
    metadata: { type: Schema.Types.Mixed, required: true },
    totalKobo: { type: Number, required: true },
    shares: {
      type: [
        {
          _id: false,
          user: { type: Schema.Types.ObjectId, ref: "User", required: true },
          amountKobo: { type: Number, required: true },
          itemsKobo: { type: Number, required: true },
          status: { type: String, enum: ["unpaid", "paid"], default: "unpaid" },
          reference: { type: String, default: null },
          cardKobo: { type: Number, default: 0 },
          walletKobo: { type: Number, default: 0 },
          paidAt: { type: Date, default: null },
        },
      ],
      default: [],
    },
    payments: {
      type: [
        {
          _id: false,
          reference: { type: String, required: true },
          user: { type: Schema.Types.ObjectId, ref: "User", required: true },
          cardKobo: { type: Number, required: true },
          walletKobo: { type: Number, required: true },
          status: { type: String, enum: ["pending", "paid", "refunded"], default: "pending" },
          createdAt: { type: Date, required: true },
        },
      ],
      default: [],
    },
    order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    cancelReason: { type: String, default: "" },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SharedCheckoutSchema.index({ status: 1, expiresAt: 1 });
SharedCheckoutSchema.index({ "payments.reference": 1 });

export default mongoose.model<ISharedCheckout>("SharedCheckout", SharedCheckoutSchema);
