import mongoose, { Schema, Document } from "mongoose";

export interface IReview extends Document {
  product: mongoose.Types.ObjectId;
  merchant: mongoose.Types.ObjectId | null;
  user: mongoose.Types.ObjectId;
  fulfilment: mongoose.Types.ObjectId;
  rating: number;
  comment: string;
  // First name only, shown publicly.
  authorName: string;
}

const ReviewSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: "ProductTemplate", required: true },
    merchant: { type: Schema.Types.ObjectId, ref: "Merchant", default: null },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fulfilment: { type: Schema.Types.ObjectId, ref: "Fulfilment", required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: "" },
    authorName: { type: String, required: true },
  },
  { timestamps: true }
);

// A customer reviews each item once per order they bought it in.
ReviewSchema.index({ user: 1, product: 1, fulfilment: 1 }, { unique: true });
ReviewSchema.index({ product: 1, createdAt: -1 });
ReviewSchema.index({ merchant: 1 });

export default mongoose.model<IReview>("Review", ReviewSchema);
