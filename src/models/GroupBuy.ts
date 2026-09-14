import mongoose, { Document, Schema } from "mongoose";

export const GROUP_BUY_STATUSES = ["open", "closed"] as const;
export type GroupBuyStatus = (typeof GROUP_BUY_STATUSES)[number];

export type GroupBuyTier = { minQuantity: number; priceKobo: number };

export type GroupBuyParticipant = {
  user: mongoose.Types.ObjectId;
  order: mongoose.Types.ObjectId;
  quantity: number;
  joinedAt: Date;
  // Set once the group has closed and any savings are in the buyer's wallet.
  settled: boolean;
  savingsKobo: number;
};

// Shoppers buying the same product together. Everyone pays the normal price; when the group closes,
// the difference to the group price they reached is credited to their wallets.
export interface IGroupBuy extends Document {
  product: mongoose.Types.ObjectId;
  merchant: mongoose.Types.ObjectId | null;
  starter: mongoose.Types.ObjectId;
  code: string;
  title: string;
  imageUrl: string | null;
  // The price and group prices when the group started, so later product edits don't change the deal.
  basePriceKobo: number;
  tiers: GroupBuyTier[];
  status: GroupBuyStatus;
  expiresAt: Date;
  participants: GroupBuyParticipant[];
  closedAt: Date | null;
  finalQuantity: number | null;
  finalUnitPriceKobo: number | null;
  createdAt: Date;
}

const GroupBuySchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: "ProductTemplate", required: true },
    merchant: { type: Schema.Types.ObjectId, ref: "Merchant", default: null },
    starter: { type: Schema.Types.ObjectId, ref: "User", required: true },
    code: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    imageUrl: { type: String, default: null },
    basePriceKobo: { type: Number, required: true },
    tiers: { type: [{ _id: false, minQuantity: Number, priceKobo: Number }], default: [] },
    status: { type: String, enum: GROUP_BUY_STATUSES, default: "open" },
    expiresAt: { type: Date, required: true },
    participants: {
      type: [
        {
          _id: false,
          user: { type: Schema.Types.ObjectId, ref: "User", required: true },
          order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
          quantity: { type: Number, required: true },
          joinedAt: { type: Date, required: true },
          settled: { type: Boolean, default: false },
          savingsKobo: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    closedAt: { type: Date, default: null },
    finalQuantity: { type: Number, default: null },
    finalUnitPriceKobo: { type: Number, default: null },
  },
  { timestamps: true }
);

GroupBuySchema.index({ status: 1, expiresAt: 1 });
GroupBuySchema.index({ product: 1, status: 1 });
GroupBuySchema.index({ starter: 1, status: 1 });
GroupBuySchema.index({ "participants.user": 1 });

export default mongoose.model<IGroupBuy>("GroupBuy", GroupBuySchema);
