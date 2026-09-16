import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPPORT_EMAIL = "help@impressa.test";
});

vi.mock("../src/services/claude", () => ({ claudeConfigured: vi.fn(() => true), createMessage: vi.fn() }));
vi.mock("../src/services/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/email")>();
  return { ...actual, sendSupportEscalationEmail: vi.fn() };
});

import app from "../src/app";
import Fulfilment from "../src/models/Fulfilment";
import { createMessage } from "../src/services/claude";
import { sendSupportEscalationEmail } from "../src/services/email";
import {
  auth,
  clearDatabase,
  createMerchant,
  createParcel,
  createUser,
  setMarketplaceSettings,
  startDatabase,
  stopDatabase,
} from "./helpers";

const createMock = vi.mocked(createMessage);
const emailMock = vi.mocked(sendSupportEscalationEmail);

const textReply = (text: string) =>
  ({ id: "msg_text", type: "message", role: "assistant", model: "test", content: [{ type: "text", text, citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: {} }) as any;

const toolCall = (name: string, input: object = {}) =>
  ({ id: "msg_tool", type: "message", role: "assistant", model: "test", content: [{ type: "tool_use", id: `toolu_${name}`, name, input }], stop_reason: "tool_use", stop_sequence: null, usage: {} }) as any;

const chat = (body: object, token?: string) => {
  const req = request(app).post("/api/support/messages");
  return (token ? req.set(auth(token)) : req).send(body);
};

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  createMock.mockReset();
  emailMock.mockReset().mockResolvedValue(undefined);
});

describe("support assistant", () => {
  it("answers a signed-out visitor from the current policies, without account lookups", async () => {
    await setMarketplaceSettings({ returnWindowDays: 5 });
    createMock.mockResolvedValue(textReply("You can ask for a return within 5 days of delivery."));

    const res = await chat({ message: "How long do I have to return something?" }).expect(200);

    expect(res.body).toMatchObject({ reply: "You can ask for a return within 5 days of delivery.", handoffSuggested: false, canEmailSupport: true });
    const params = createMock.mock.calls[0][0];
    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.system).toContain("within 5 days of delivery");
    expect(params.tools?.map((tool) => tool.name)).toEqual(["hand_off_to_support"]);
  });

  it("looks up only the signed-in customer's own orders", async () => {
    const seller = await createMerchant();
    const customer = await createUser();
    const stranger = await createUser();
    const mine = await createParcel({ merchant: seller.merchant, customerId: customer.user._id, status: "shipped" });
    const theirs = await createParcel({ merchant: seller.merchant, customerId: stranger.user._id, status: "shipped" });
    await Fulfilment.updateOne({ _id: mine.fulfilment._id }, { $set: { tracking: { status: "in-transit", code: "GIG-778812" } } });

    createMock.mockResolvedValueOnce(toolCall("list_my_orders")).mockResolvedValueOnce(textReply("Your parcel is on the way."));
    const res = await chat({ message: "Where is my order?" }, customer.token).expect(200);

    expect(res.body.reply).toBe("Your parcel is on the way.");
    const toolResult = JSON.stringify(createMock.mock.calls[1][0].messages.at(-1));
    expect(toolResult).toContain(String(mine.order._id).slice(-6).toUpperCase());
    expect(toolResult).toContain("GIG-778812");
    expect(toolResult).not.toContain(String(theirs.order._id).slice(-6).toUpperCase());
    expect(createMock.mock.calls[0][0].tools?.map((tool) => tool.name)).toContain("get_order");
  });

  it("only continues a chat with its token", async () => {
    createMock.mockResolvedValue(textReply("Hello!"));
    const first = await chat({ message: "Hi" }).expect(200);

    await chat({ message: "Me again", conversationId: first.body.conversationId, token: first.body.token }).expect(200);
    const res = await chat({ message: "Me again", conversationId: first.body.conversationId, token: "a".repeat(48) }).expect(404);
    expect(res.body.error).toBe("This chat has ended. Start a new one.");
  });

  it("emails the conversation to the support team once", async () => {
    createMock.mockResolvedValueOnce(toolCall("hand_off_to_support", { reason: "Payment taken, no order" })).mockResolvedValueOnce(textReply("I've flagged this for our team."));
    const started = await chat({ message: "I paid but there's no order" }).expect(200);
    expect(started.body.handoffSuggested).toBe(true);

    const escalate = (body: object) =>
      request(app).post("/api/support/escalate").send({ conversationId: started.body.conversationId, token: started.body.token, ...body });

    await escalate({}).expect(400);
    const sent = await escalate({ email: "Ada@Example.com", note: "Paid ₦19,500 at 2pm" }).expect(200);
    expect(sent.body.message).toBe("Sent. Our support team will reply to ada@example.com by email.");
    expect(emailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "help@impressa.test", customerEmail: "ada@example.com", note: "Paid ₦19,500 at 2pm" })
    );
    expect(emailMock.mock.calls[0][0].transcript).toHaveLength(2);

    await escalate({ email: "ada@example.com" }).expect(409);
  });

  it("points to email support when the assistant fails", async () => {
    createMock.mockRejectedValue(new Error("overloaded"));
    const res = await chat({ message: "Hello" }).expect(503);
    expect(res.body.error).toContain("help@impressa.test");
  });
});
