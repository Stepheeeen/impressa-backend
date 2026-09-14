import mongoose, { Schema, Document } from "mongoose";

export interface IDeviceToken extends Document {
  user: mongoose.Types.ObjectId;
  token: string;
  platform: "ios" | "android";
  appVersion?: string;
}

const DeviceTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // One row per device: signing in as someone else on the same phone moves the token to that account.
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ["ios", "android"], required: true },
    appVersion: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model<IDeviceToken>("DeviceToken", DeviceTokenSchema);
