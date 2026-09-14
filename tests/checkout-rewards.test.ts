import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/paystack", () => ({
  initializeTransaction: vi.fn(),
  verifyTransaction: vi.fn(),
}));

import app from "../src/app";
import { HttpError } from "../src/middleware/errorHandler";
import Coupon from "../src/models/Coupon";
import CouponRedemption from "../src/models/CouponRedemption";
import Order from "../src/models/Order";
import WalletHold from "../src/models/WalletHold";
import WalletTransaction from "../src/models/WalletTransaction";
import { initializeTransaction, verifyTransaction } from "../src/services/paystack";
import { creditWallet, getAvailableCreditKobo } from "../src/services/wallet";
import {
  auth,
  clearDatabase,
  createOrder,
  createProduct,
  createUser,
  setRewardSettings,
  signedWebhook,
  startDatabase,
  stopDatabase,
} from "./helpers";

const initializeMock = vi.mocked(initializeTransaction);
const verifyMock = vi.mocked(verifyTransaction);
const delivery = { state: "Lagos", address: "12 Admiralty Way, Lekki Phase 1", phone: "0801 234 5678" };

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  initializeMock.mockReset();
  verifyMock.mockReset();
  initializeMock.mockImplementation(async ({ reference }) => ({
    authorizationUrl: "https://checkout.paystack.com/abc123",
    reference: reference ?? "ref_missing",
  }));
});

// Two ₦9,000 dresses: ₦18,000 of items plus ₦1,500 delivery.
async function shopper(walletNaira = 0) {
  const buyer = await createUser();
  const product = await createProduct({ price: 9000 });
  await request(app).post("/api/cart/add").set(auth(buyer.token)).send({ templateId: product.id, quantity: 2 }).expect(200);
  if (walletNaira > 0) {
    await creditWallet({
      userId: buyer.user.id,
      amountKobo: walletNaira * 100,
      source: "adjustment",
      expiryDays: 90,
      idempotencyKey: `seed-${buyer.user.id}`,
    });
  }
  return buyer;
}

const quote = (token: string, body: object) => request(app).post("/api/pay/quote").set(auth(token)).send(body);
const pay = (token: string, body: object) =>
  request(app).post("/api/pay/initialize").set(auth(token)).send({ ...delivery, ...body });

function paidTransaction(email: string) {
  const args = initializeMock.mock.calls[0][0];
  return {
    reference: args.reference!,
    status: "success",
    amount: args.amountKobo,
    currency: "NGN",
    customer: { email },
    metadata: args.metadata,
  };
}

describe("checkout quote", () => {
  it("takes a coupon off the items and wallet credit off the rest", async () => {
    await Coupon.create({ code: "SAVE10", type: "percent", percentOff: 10 });
    const buyer = await shopper(5000);

    const res = await quote(buyer.token, { couponCode: "save10", useWallet: true }).expect(200);
    expect(res.body).toMatchObject({
      subtotal: 18000,
      deliveryFee: 1500,
      discount: 1800,
      walletApplied: 5000,
      total: 17700,
      cardAmount: 12700,
      couponError: null,
    });
  });

  it("explains why a coupon can't be used", async () => {
    const buyer = await shopper();
    const res = await quote(buyer.token, { couponCode: "NOPE" }).expect(200);
    expect(res.body).toMatchObject({ couponError: "That coupon code isn't valid.", discount: 0 });
  });

  it("limits credit to the items when the admin chooses that", async () => {
    await setRewardSettings({ walletUsageMode: "items-only" });
    const buyer = await shopper(50_000);
    const res = await quote(buyer.token, { useWallet: true }).expect(200);
    expect(res.body).toMatchObject({ walletApplied: 18000, cardAmount: 1500 });
  });

  it("limits credit to a share of the items", async () => {
    await setRewardSettings({ walletUsageMode: "percent-of-items", walletUsagePercent: 50 });
    const buyer = await shopper(50_000);
    const res = await quote(buyer.token, { useWallet: true }).expect(200);
    expect(res.body).toMatchObject({ walletApplied: 9000, cardAmount: 10500 });
  });

  it("leaves at least ₦100 for the card", async () => {
    const buyer = await shopper(19_450);
    const res = await quote(buyer.token, { useWallet: true }).expect(200);
    expect(res.body).toMatchObject({ walletApplied: 19400, cardAmount: 100 });
  });
});

describe("paying with wallet credit and coupons", () => {
  it("holds the credit and charges only the rest to the card", async () => {
    const buyer = await shopper(5000);

    const res = await pay(buyer.token, { useWallet: true }).expect(200);

    const args = initializeMock.mock.calls[0][0];
    expect(args.amountKobo).toBe(1_450_000);
    expect(args.metadata).toMatchObject({ walletApplied: 5000, orderTotal: 19500, totalAmount: 14500 });
    expect(res.body).toMatchObject({ paid: false, amount: 14500, walletApplied: 5000 });
    expect(await getAvailableCreditKobo(buyer.user.id)).toBe(0);
    expect((await WalletHold.findOne({ reference: args.reference }))?.status).toBe("held");
  });

  it("completes a wallet-only order without Paystack", async () => {
    const buyer = await shopper(20_000);

    const res = await pay(buyer.token, { useWallet: true }).expect(200);

    expect(res.body.paid).toBe(true);
    expect(initializeMock).not.toHaveBeenCalled();
    const order = await Order.findById(res.body.orderId).lean();
    expect(order?.totalAmount).toBe(19500);
    expect(order?.pricing).toMatchObject({ walletAppliedKobo: 1_950_000, cardPaidKobo: 0 });
    expect(await getAvailableCreditKobo(buyer.user.id)).toBe(50_000);
    expect((await WalletHold.findOne({ reference: res.body.reference }))?.status).toBe("committed");
  });

  it("gives the credit back if Paystack can't start the payment", async () => {
    initializeMock.mockRejectedValue(new HttpError(502, "Couldn't start the payment. Please try again."));
    const buyer = await shopper(5000);

    await pay(buyer.token, { useWallet: true }).expect(502);

    expect(await getAvailableCreditKobo(buyer.user.id)).toBe(500_000);
  });

  it("creates one order, spends the credit and uses the coupon once when verify and the webhook race", async () => {
    await Coupon.create({ code: "WELCOME", type: "fixed", amountOffKobo: 100_000 });
    const buyer = await shopper(2000);
    await pay(buyer.token, { couponCode: "WELCOME", useWallet: true }).expect(200);

    const paid = paidTransaction(buyer.user.email);
    verifyMock.mockResolvedValue(paid);
    const { body, signature } = signedWebhook({ event: "charge.success", data: paid });
    const webhook = () =>
      request(app)
        .post("/api/pay/webhook")
        .set("Content-Type", "application/json")
        .set("x-paystack-signature", signature)
        .send(body);

    await Promise.all([request(app).get(`/api/pay/verify/${paid.reference}`).set(auth(buyer.token)), webhook(), webhook()]);

    expect(await Order.countDocuments()).toBe(1);
    expect(await CouponRedemption.countDocuments()).toBe(1);
    expect((await Coupon.findOne({ code: "WELCOME" }))?.timesUsed).toBe(1);
    expect((await WalletHold.findOne({ reference: paid.reference }))?.status).toBe("committed");
    // ₦18,000 − ₦1,000 coupon + ₦1,500 delivery = ₦18,500; ₦2,000 from the wallet, ₦16,500 by card.
    expect((await Order.findOne().lean())?.pricing).toMatchObject({
      discountKobo: 100_000,
      walletAppliedKobo: 200_000,
      cardPaidKobo: 1_650_000,
    });
  });

  it("won't let a customer use a one-time coupon twice", async () => {
    const coupon = await Coupon.create({ code: "ONCE", type: "fixed", amountOffKobo: 50_000 });
    const buyer = await shopper();
    await CouponRedemption.create({ coupon: coupon._id, user: buyer.user._id, reference: "ref_earlier", discountKobo: 50_000 });

    const res = await pay(buyer.token, { couponCode: "ONCE" }).expect(400);
    expect(res.body.error).toBe("You've already used this coupon.");
  });
});

describe("cashback", () => {
  it("pays cashback on the card-paid part once the order is delivered, once", async () => {
    const admin = await createUser({ role: "admin" });
    const buyer = await shopper(5000);
    await pay(buyer.token, { useWallet: true }).expect(200);
    const paid = paidTransaction(buyer.user.email);
    verifyMock.mockResolvedValue(paid);
    const verified = await request(app).get(`/api/pay/verify/${paid.reference}`).set(auth(buyer.token)).expect(200);

    const deliver = () =>
      request(app)
        .patch(`/api/orders/${verified.body.orderId}/status`)
        .set(auth(admin.token))
        .send({ status: "delivered" })
        .expect(200);
    await deliver();
    await deliver();

    // 2% of the ₦14,500 paid by card.
    expect(await getAvailableCreditKobo(buyer.user.id)).toBe(29_000);
    expect(await WalletTransaction.countDocuments({ source: "cashback" })).toBe(1);
    expect((await Order.findById(verified.body.orderId))?.cashbackKobo).toBe(29_000);
  });

  it("doesn't pay cashback on orders placed before the wallet checkout", async () => {
    const admin = await createUser({ role: "admin" });
    const { user } = await createUser();
    const order = await createOrder(user._id, { status: "shipped" });

    await request(app).patch(`/api/orders/${order.id}/status`).set(auth(admin.token)).send({ status: "delivered" }).expect(200);

    expect(await getAvailableCreditKobo(user.id)).toBe(0);
  });
});
