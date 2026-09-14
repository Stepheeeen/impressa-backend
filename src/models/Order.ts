import mongoose, { Schema, Document } from "mongoose";

export const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Delivery stages the admin panel's orders table offers.
export const TRACKING_STATUSES = ["processing", "in-transit", "ready-for-pickup", "delivered", "failed"] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  itemType: string;
  quantity: number;
  totalAmount: number;
  deliveryAddress: {
    address: string;
    state: string;
    country: string;
    phone: string;
  };
  status: OrderStatus;
  paymentRef: string;
  email?: string;
  items?: any[];
  itemNames?: string[]; // <- added
  instructions?: string;
  statusHistory?: { status: OrderStatus; at: Date }[];
  tracking?: { status?: TrackingStatus; code?: string; updatedAt?: Date };
  pricing?: {
    subtotalKobo: number;
    deliveryFeeKobo: number;
    discountKobo: number;
    couponCode?: string;
    walletAppliedKobo: number;
    cardPaidKobo: number;
  };
  walletShortfallKobo?: number;
  cashbackKobo?: number;
  cardRefundedKobo?: number;
  // Shared cart orders paid by several members. Refunds and cashback are split between the payers.
  sharedCart?: mongoose.Types.ObjectId | null;
  payers?: {
    user: mongoose.Types.ObjectId;
    reference: string;
    cardPaidKobo: number;
    walletAppliedKobo: number;
    cardRefundedKobo: number;
  }[];
}

const OrderSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    itemType: { type: String, required: true },
    quantity: { type: Number, required: true },
    totalAmount: { type: Number, required: true },

    deliveryAddress: {
      address: { type: String, required: true },
      state: { type: String, required: true },
      country: { type: String, required: true },
      phone: { type: String, required: true },
    },

    // Unique so the verify call and Paystack's webhook can't both create an order for one payment.
    paymentRef: { type: String, required: true, unique: true },

    status: {
      type: String,
      enum: ORDER_STATUSES,
      default: "paid",
    },

    email: { type: String },
    items: { type: Array, default: [] },
    itemNames: { type: [String], default: [] }, // <- added
    instructions: { type: String },

    // Every status change with its time, shown to customers as a tracking timeline.
    statusHistory: {
      type: [{ _id: false, status: { type: String, enum: ORDER_STATUSES }, at: { type: Date, required: true } }],
      default: [],
    },

    // Delivery stage and courier tracking number or link, set by an admin from the orders table.
    tracking: {
      status: { type: String, enum: TRACKING_STATUSES },
      code: { type: String },
      updatedAt: { type: Date },
    },

    // How the order was paid (kobo), for orders from the checkout with coupons and wallet credit.
    pricing: {
      type: new Schema(
        {
          subtotalKobo: Number,
          deliveryFeeKobo: Number,
          discountKobo: Number,
          couponCode: String,
          walletAppliedKobo: Number,
          cardPaidKobo: Number,
        },
        { _id: false }
      ),
      default: undefined,
    },

    // Wallet credit that was already gone when a late payment completed; needs manual follow-up.
    walletShortfallKobo: { type: Number },
    cashbackKobo: { type: Number },
    // Refunded to the card so far, so refunds never exceed what the card paid.
    cardRefundedKobo: { type: Number, default: 0 },

    sharedCart: { type: Schema.Types.ObjectId, ref: "SharedCart", default: null },
    // Each member's Paystack payment for their share, so refunds go back to the right card.
    payers: {
      type: [
        {
          _id: false,
          user: { type: Schema.Types.ObjectId, ref: "User", required: true },
          reference: { type: String, required: true },
          cardPaidKobo: { type: Number, default: 0 },
          walletAppliedKobo: { type: Number, default: 0 },
          cardRefundedKobo: { type: Number, default: 0 },
        },
      ],
      default: undefined,
    },
  },
  { timestamps: true }
);

OrderSchema.index({ "payers.user": 1 }, { sparse: true });

export default mongoose.model<IOrder>("Order", OrderSchema);
