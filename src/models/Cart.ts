import mongoose, { Schema, Document } from "mongoose";

export interface ICart extends Document {
  user: mongoose.Types.ObjectId;
  items: {
    templateId?: mongoose.Types.ObjectId;
    designId?: mongoose.Types.ObjectId;
    itemType: string;
    size?: string;
    quantity: number;
    price: number;
    color?: string;
    description?: string;
    groupBuy?: mongoose.Types.ObjectId;
  }[];
}

const CartSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    items: [
      {
        templateId: { type: Schema.Types.ObjectId, ref: "ProductTemplate" },
        designId: { type: Schema.Types.ObjectId, ref: "Design" },
        itemType: String,
        size: String,
        quantity: Number,
        price: Number,
        color: String,
        description: String,
        // Bought through this group buy.
        groupBuy: { type: Schema.Types.ObjectId, ref: "GroupBuy" },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model<ICart>("Cart", CartSchema);