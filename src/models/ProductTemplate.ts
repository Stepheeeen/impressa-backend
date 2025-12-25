import mongoose, { Schema, Document } from "mongoose";

export interface IProductTemplate extends Document {
  title: string;
  itemType: string;
  category: string;
  imageUrls: string[]; // corrected to plural
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
    imageUrls: { type: [String], required: true }, // keep plural consistent
    price: { type: Number, required: true },

    // use proper array schema shape so updates of arrays work as expected
    sizes: { type: [String], default: [] },
    colors: { type: [String], default: [] },
    tags: [{ type: String }],

    customizable: { type: Boolean, default: false },
    isFeatured: { type: Boolean, default: false },
    inStock: { type: Boolean, default: true },
    description: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model<IProductTemplate>("ProductTemplate", ProductTemplateSchema);
