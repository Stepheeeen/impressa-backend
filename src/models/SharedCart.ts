import mongoose, { Document, Schema } from "mongoose";

export const SHARED_CART_STATUSES = ["open", "collecting"] as const;
export type SharedCartStatus = (typeof SHARED_CART_STATUSES)[number];

export type SharedCartItem = {
  _id: mongoose.Types.ObjectId;
  templateId: mongoose.Types.ObjectId;
  size?: string;
  color?: string;
  quantity: number;
  // Who added it. When each person pays for their own items, this is who pays.
  addedBy: mongoose.Types.ObjectId;
};

// A cart friends fill together. Any member can change any item; the owner checks out.
export interface ISharedCart extends Document {
  owner: mongoose.Types.ObjectId;
  name: string;
  code: string;
  members: { user: mongoose.Types.ObjectId; joinedAt: Date }[];
  items: SharedCartItem[];
  // "collecting" while members pay their shares; the items can't change then.
  status: SharedCartStatus;
  checkout: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const SharedCartSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, maxlength: 60 },
    code: { type: String, required: true, unique: true },
    members: {
      type: [
        {
          _id: false,
          user: { type: Schema.Types.ObjectId, ref: "User", required: true },
          joinedAt: { type: Date, required: true },
        },
      ],
      default: [],
    },
    items: {
      type: [
        {
          templateId: { type: Schema.Types.ObjectId, ref: "ProductTemplate", required: true },
          size: String,
          color: String,
          quantity: { type: Number, required: true, min: 1 },
          addedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        },
      ],
      default: [],
    },
    status: { type: String, enum: SHARED_CART_STATUSES, default: "open" },
    checkout: { type: Schema.Types.ObjectId, ref: "SharedCheckout", default: null },
  },
  { timestamps: true }
);

SharedCartSchema.index({ "members.user": 1, updatedAt: -1 });

export default mongoose.model<ISharedCart>("SharedCart", SharedCartSchema);
