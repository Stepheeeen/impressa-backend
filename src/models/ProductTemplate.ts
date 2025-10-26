import mongoose, { Schema, Document } from "mongoose";

export interface IProductTemplate extends Document {
  title: string;
  itemType: string; // e.g., "shirt", "hoodie", "mug"
  category: string;
  imageUrl: string;
  price: number;
  sizes: string[];
  colors: string[];
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const ProductTemplateSchema: Schema = new Schema(
  {
    title: { type: String, required: true },
    itemType: { type: String, required: true },
    category: { type: String, required: true },
    imageUrl: { type: String, required: true },
    price: { type: Number, required: true },
    sizes: [{ type: String, default: [] }],
    colors: [{ type: String, default: [] }],
    tags: [{ type: String }]
  },
  { timestamps: true }
);

export default mongoose.model<IProductTemplate>(
  "ProductTemplate",
  ProductTemplateSchema
);
