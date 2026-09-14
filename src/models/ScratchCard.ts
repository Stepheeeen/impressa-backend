import mongoose, { Schema, Document } from "mongoose";

export interface IScratchCard extends Document {
  user: mongoose.Types.ObjectId;
  day: string; // YYYY-MM-DD in Lagos time
  slot: number; // 1 for the day's first card, 2 for the second, ...
  amountKobo: number;
}

const ScratchCardSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    day: { type: String, required: true },
    slot: { type: Number, required: true },
    amountKobo: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

// Each daily slot can be used once, so simultaneous requests can't exceed the daily limit.
ScratchCardSchema.index({ user: 1, day: 1, slot: 1 }, { unique: true });

export default mongoose.model<IScratchCard>("ScratchCard", ScratchCardSchema);
