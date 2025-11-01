import mongoose, { Schema, Document } from "mongoose";

export interface ICart extends Document {
  user: mongoose.Types.ObjectId;
  items: {
    templateId?: mongoose.Types.ObjectId;
    designId?: mongoose.Types.ObjectId;
    itemType: string;
    quantity: number;
    price: number;
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
        quantity: Number,
        price: Number,
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model<ICart>("Cart", CartSchema);