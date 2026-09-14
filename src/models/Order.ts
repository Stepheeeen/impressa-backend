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
  },
  { timestamps: true }
);

export default mongoose.model<IOrder>("Order", OrderSchema);
