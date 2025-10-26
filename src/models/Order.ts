import mongoose, { Schema, Document } from "mongoose";

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  designId?: mongoose.Types.ObjectId;
  templateId?: mongoose.Types.ObjectId;
  itemType: string;
  quantity: number;
  totalAmount: number;
  deliveryAddress: string;
  status: "pending" | "paid" | "shipped" | "delivered";
  paymentRef: string;
}

const OrderSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    designId: { type: Schema.Types.ObjectId, ref: "Design" },
    templateId: { type: Schema.Types.ObjectId, ref: "ProductTemplate" },
    itemType: { type: String, required: true },
    quantity: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    deliveryAddress: { type: String, required: true },
    paymentRef: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "paid", "shipped", "delivered"],
      default: "pending",
    },
  },
  { timestamps: true }
);

export default mongoose.model<IOrder>("Order", OrderSchema);
