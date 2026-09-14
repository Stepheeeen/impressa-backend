import mongoose, { Document, Schema } from "mongoose";

export type SupportMessage = { role: "user" | "assistant"; text: string; at: Date };

// A chat with the support assistant. Kept for 90 days so escalations have context, then deleted automatically.
export interface ISupportConversation extends Document {
  user: mongoose.Types.ObjectId | null;
  // Lets a signed-out visitor continue their own chat without an account.
  token: string;
  messages: SupportMessage[];
  // Set when the assistant thinks a person should take over.
  handoffSuggested: boolean;
  escalatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SupportConversationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    token: { type: String, required: true },
    messages: {
      type: [
        {
          _id: false,
          role: { type: String, enum: ["user", "assistant"], required: true },
          text: { type: String, required: true },
          at: { type: Date, required: true },
        },
      ],
      default: [],
    },
    handoffSuggested: { type: Boolean, default: false },
    escalatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SupportConversationSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default mongoose.model<ISupportConversation>("SupportConversation", SupportConversationSchema);
