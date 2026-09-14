import mongoose, { Schema, Document } from "mongoose";

export const BANNER_LINK_TYPES = ["none", "product", "category", "priceBand"] as const;
export type BannerLinkType = (typeof BANNER_LINK_TYPES)[number];

export interface IBanner extends Document {
  title: string;
  subtitle?: string;
  imageUrl: string;
  // What tapping the banner opens: a product id, a category name, or a price band id.
  linkType: BannerLinkType;
  linkValue?: string;
  // Optional schedule; a banner is live between these dates.
  startsAt?: Date | null;
  endsAt?: Date | null;
  sortOrder: number;
  active: boolean;
}

const BannerSchema = new Schema(
  {
    title: { type: String, required: true },
    subtitle: { type: String, default: "" },
    imageUrl: { type: String, required: true },
    linkType: { type: String, enum: BANNER_LINK_TYPES, default: "none" },
    linkValue: { type: String, default: "" },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model<IBanner>("Banner", BannerSchema);
