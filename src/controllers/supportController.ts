import { Request, Response } from "express";
import { z } from "zod";
import { escalateSupportConversation, MAX_MESSAGE_LENGTH, sendSupportMessage, supportConfig } from "../services/support";

const chatEnded = "This chat has ended. Start a new one.";
const ConversationFields = {
  conversationId: z.string({ error: chatEnded }).regex(/^[a-f0-9]{24}$/i, chatEnded),
  token: z.string({ error: chatEnded }).regex(/^[a-f0-9]{48}$/, chatEnded),
};

const MessageSchema = z.object({
  conversationId: ConversationFields.conversationId.optional(),
  token: ConversationFields.token.optional(),
  message: z
    .string({ error: "Type a message." })
    .trim()
    .min(1, "Type a message.")
    .max(MAX_MESSAGE_LENGTH, `Keep messages under ${MAX_MESSAGE_LENGTH.toLocaleString("en-NG")} characters.`),
});

const EscalateSchema = z.object({
  ...ConversationFields,
  // Only needed when the customer isn't signed in.
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")).optional(),
  note: z.string().trim().max(500, "Keep the note under 500 characters.").optional(),
});

// GET /api/support/config
export const getSupportConfig = (_req: Request, res: Response) => {
  res.json(supportConfig());
};

// POST /api/support/messages
export const postSupportMessage = async (req: Request, res: Response) => {
  const { conversationId, token, message } = MessageSchema.parse(req.body ?? {});
  res.json(await sendSupportMessage({ userId: req.user?.id ?? null, conversationId, token, text: message }));
};

// POST /api/support/escalate
export const escalateSupport = async (req: Request, res: Response) => {
  const input = EscalateSchema.parse(req.body ?? {});
  res.json(await escalateSupportConversation({ userId: req.user?.id ?? null, ...input }));
};
