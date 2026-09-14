import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";

// The only place the Claude API is called, so tests can replace it.
const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 30_000 }) : null;

export const claudeConfigured = () => client !== null;

export async function createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  if (!client) throw new Error("ANTHROPIC_API_KEY is not set");
  return client.messages.create(params);
}
