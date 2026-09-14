import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/paystack", () => ({
  initializeTransaction: vi.fn(),
  verifyTransaction: vi.fn(),
}));

import app from "../src/app";
import Order from "../src/models/Order";
import { initializeTransaction, verifyTransaction } from "../src/services/paystack";
import { auth, clearDatabase, createProduct, createUser, signedWebhook, startDatabase, stopDatabase } from "./helpers";

const initializeMock = vi.mocked(initializeTransaction);
const verifyMock = vi.mocked(verifyTransaction);

const delivery = { state: "Lagos", address: "12 Admiralty Way, Lekki Phase 1", phone: "0801 234 5678" };

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  initializeMock.mockReset();
  verifyMock.mockReset();
  initializeMock.mockResolvedValue({ authorizationUrl: "https://checkout.paystack.com/abc123", reference: "ref_abc123" });
});

// Two ₦9,000 dresses, with a tampered amount and email in the request.
async function checkout() {
  const buyer = await createUser();
  const product = await createProduct({ price: 9000 });
  await request(app).post("/api/cart/add").set(auth(buyer.token)).send({ templateId: product.id, quantity: 2 }).expect(200);

  const res = await request(app)
    .post("/api/pay/initialize")
    .set(auth(buyer.token))
    .send({ ...delivery, amount: 100, email: "someone-else@example.com" })
    .expect(200);

  const args = initializeMock.mock.calls[0][0];
  const paidTransaction = {
    reference: "ref_abc123",
    status: "success",
    amount: args.amountKobo,
    currency: "NGN",
    customer: { email: buyer.user.email },
    metadata: args.metadata,
  };
  return { buyer, res, args, paidTransaction };
}

describe("payment initialization", () => {
  it("charges the total calculated on the server", async () => {
    const { buyer, res, args } = await checkout();
    expect(args.amountKobo).toBe(1_950_000); // (₦9,000 × 2 + ₦1,500 delivery) in kobo
    expect(args.email).toBe(buyer.user.email);
    expect(res.body.amount).toBe(19500);
  });

  it("refuses an empty cart", async () => {
    const { token } = await createUser();
    await request(app).post("/api/pay/initialize").set(auth(token)).send(delivery).expect(400);
    expect(initializeMock).not.toHaveBeenCalled();
  });

  it("requires a Nigerian state", async () => {
    const { token } = await createUser();
    const product = await createProduct();
    await request(app).post("/api/cart/add").set(auth(token)).send({ templateId: product.id }).expect(200);
    await request(app).post("/api/pay/initialize").set(auth(token)).send({ ...delivery, state: "Atlantis" }).expect(400);
  });
});

describe("payment verification", () => {
  it("creates an order when the amount paid matches", async () => {
    const { buyer, paidTransaction } = await checkout();
    verifyMock.mockResolvedValue(paidTransaction);

    await request(app).get("/api/pay/verify/ref_abc123").set(auth(buyer.token)).expect(200);

    const orders = await Order.find();
    expect(orders).toHaveLength(1);
    expect(orders[0].totalAmount).toBe(19500);
  });

  it("doesn't create an order when the amount paid is different", async () => {
    const { buyer, paidTransaction } = await checkout();
    verifyMock.mockResolvedValue({ ...paidTransaction, amount: 10_000 });

    await request(app).get("/api/pay/verify/ref_abc123").set(auth(buyer.token)).expect(409);
    expect(await Order.countDocuments()).toBe(0);
  });

  it("creates exactly one order when verify and the webhook arrive together", async () => {
    const { buyer, paidTransaction } = await checkout();
    verifyMock.mockResolvedValue(paidTransaction);
    const { body, signature } = signedWebhook({ event: "charge.success", data: paidTransaction });

    await Promise.all([
      request(app).get("/api/pay/verify/ref_abc123").set(auth(buyer.token)),
      request(app)
        .post("/api/pay/webhook")
        .set("Content-Type", "application/json")
        .set("x-paystack-signature", signature)
        .send(body),
      request(app)
        .post("/api/pay/webhook")
        .set("Content-Type", "application/json")
        .set("x-paystack-signature", signature)
        .send(body),
    ]);

    expect(await Order.countDocuments({ paymentRef: "ref_abc123" })).toBe(1);
  });

  it("rejects a webhook with a bad signature", async () => {
    const { paidTransaction } = await checkout();
    const { body } = signedWebhook({ event: "charge.success", data: paidTransaction });

    await request(app)
      .post("/api/pay/webhook")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", "0".repeat(128))
      .send(body)
      .expect(401);
    expect(await Order.countDocuments()).toBe(0);
  });

  it("doesn't let one customer verify another customer's payment", async () => {
    const { paidTransaction } = await checkout();
    const stranger = await createUser();
    verifyMock.mockResolvedValue(paidTransaction);

    await request(app).get("/api/pay/verify/ref_abc123").set(auth(stranger.token)).expect(404);
  });
});
