import mongoose, { Schema, Document } from "mongoose";

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
  status: "pending" | "paid" | "shipped" | "delivered";
  paymentRef: string;
  email?: string;
  items?: any[];
  instructions?: string;
}

const OrderSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },

    itemType: { type: String, required: true },
    quantity: { type: Number, required: true },
    totalAmount: { type: Number, required: true },

    deliveryAddress: {
      address: { type: String, required: true },
      state: { type: String, required: true },
      country: { type: String, required: true },
      phone: { type: String, required: true },
    },

    paymentRef: { type: String, required: true },

    status: {
      type: String,
      enum: ["pending", "paid", "shipped", "delivered"],
      default: "paid",
    },

    email: { type: String },
    items: { type: Array, default: [] },
    instructions: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model<IOrder>("Order", OrderSchema);
