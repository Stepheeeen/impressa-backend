import mongoose, { Schema, Document } from "mongoose";

// A "shop by amount" section, e.g. "Under ₦5,000". Includes minPrice, excludes maxPrice, so bands don't overlap.
export interface IPriceBand extends Document {
  label: string;
  minPrice: number;
  maxPrice: number | null; // null means no upper limit
  sortOrder: number;
  active: boolean;
}

const PriceBandSchema = new Schema(
  {
    label: { type: String, required: true },
    minPrice: { type: Number, default: 0, min: 0 },
    maxPrice: { type: Number, default: null },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model<IPriceBand>("PriceBand", PriceBandSchema);
