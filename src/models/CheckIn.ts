import mongoose, { Schema, Document } from "mongoose";

export interface ICheckIn extends Document {
  user: mongoose.Types.ObjectId;
  day: string; // YYYY-MM-DD in Lagos time
  streakDay: number;
  amountKobo: number;
}

const CheckInSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    day: { type: String, required: true },
    streakDay: { type: Number, required: true },
    amountKobo: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

// One check-in per customer per day, even if the button is tapped twice at once.
CheckInSchema.index({ user: 1, day: 1 }, { unique: true });

export default mongoose.model<ICheckIn>("CheckIn", CheckInSchema);
