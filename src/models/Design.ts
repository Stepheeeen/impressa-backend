import mongoose, { Schema, Document } from "mongoose";

interface TextLayer {
  text: string;
  font: string;
  color: string;
  position: { x: number; y: number };
}

export interface IDesign extends Document {
  user: mongoose.Types.ObjectId;
  title: string;
  itemType: string;
  imageUrl: string;
  color: string;
  size: string;
  textLayers: TextLayer[];
}

const DesignSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    itemType: { type: String, required: true },
    imageUrl: { type: String, required: true },
    color: { type: String, required: true },
    size: { type: String, required: true },
    textLayers: [
      {
        text: String,
        font: String,
        color: String,
        position: {
          x: Number,
          y: Number,
        },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model<IDesign>("Design", DesignSchema);
