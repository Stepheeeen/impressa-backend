import mongoose, { Schema, Document } from "mongoose";

export interface IProductTemplate extends Document {
  title: string;
  itemType: string;
  category: string;
  imageUrl: string;
  price: number;
  sizes: string[];
  colors: string[];
  tags?: string[];
  customizable: boolean;
  isFeatured: boolean;
  inStock: boolean;
  description?: string;
}

const ProductTemplateSchema: Schema = new Schema(
  {
    title: { type: String, required: true },
    itemType: { type: String, required: true },
    category: { type: String, required: true },
    imageUrls: { type: [String], required: true },
    price: { type: Number, required: true },

    sizes: [{ type: String, default: [] }],
    colors: [{ type: String, default: [] }],
    tags: [{ type: String }],

    customizable: { type: Boolean, default: false },  // ✅ For "Customizable Only" filter
    isFeatured: { type: Boolean, default: false },   // ✅ For "Featured" sorting
    inStock: { type: Boolean, default: true },
    description: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model<IProductTemplate>("ProductTemplate", ProductTemplateSchema);
