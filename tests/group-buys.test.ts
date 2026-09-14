import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/paystack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/paystack")>();
  return { ...actual, initializeTransaction: vi.fn(), verifyTransaction: vi.fn(), refundTransaction: vi.fn() };
});

import app from "../src/app";
import Fulfilment from "../src/models/Fulfilment";
import GroupBuy from "../src/models/GroupBuy";
import Order from "../src/models/Order";
import { closeExpiredGroupBuys } from "../src/services/groupBuys";
import { initializeTransaction, refundTransaction } from "../src/services/paystack";
import { getAvailableCreditKobo } from "../src/services/wallet";
import {
  auth,
  clearDatabase,
  createMerchant,
  createProduct,
  createUser,
  signedWebhook,
  startDatabase,
  stopDatabase,
} from "./helpers";

const initializeMock = vi.mocked(initializeTransaction);
const refundMock = vi.mocked(refundTransaction);

const delivery = { state: "Lagos", address: "12 Admiralty Way, Lekki Phase 1", phone: "0801 234 5678" };
const groupPrices = {
  enabled: true,
  durationHours: 48,
  tiers: [
    { minQuantity: 3, price: 9000 },
    { minQuantity: 5, price: 8000 },
  ],
};

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  initializeMock.mockReset().mockImplementation(async ({ reference }) => ({
    authorizationUrl: "https://checkout.paystack.com/test",
    reference: reference!,
  }));
  refundMock.mockReset().mockResolvedValue({ status: "pending" });
});

// A ₦10,000 merchant product: ₦9,000 each for 3 or more, ₦8,000 each for 5 or more. Delivery is ₦2,000.
async function groupProduct() {
  const seller = await createMerchant();
  const product = await createProduct({ merchant: seller.merchant._id, price: 10000, stockQuantity: 50, groupBuy: groupPrices });
  return { seller, product };
}

async function startGroup(productId: string) {
  const starter = await createUser();
  const res = await request(app).post(`/api/templates/${productId}/group-buys`).set(auth(starter.token)).expect(201);
  return { starter, code: res.body.groupBuy.code as string };
}

// Adds the product through the group and pays for it, as Paystack's webhook reports.
async function buyThroughGroup(productId: string, code: string, quantity: number) {
  const buyer = await createUser();
  await request(app)
    .post("/api/cart/add")
    .set(auth(buyer.token))
    .send({ templateId: productId, quantity, size: "M", groupBuyCode: code })
    .expect(200);

  initializeMock.mockClear();
  await request(app).post("/api/pay/initialize").set(auth(buyer.token)).send(delivery).expect(200);
  const args = initializeMock.mock.calls[0][0];

  const { body, signature } = signedWebhook({
    event: "charge.success",
    data: {
      reference: args.reference,
      status: "success",
      amount: args.amountKobo,
      currency: "NGN",
      customer: { email: buyer.user.email },
      metadata: args.metadata,
    },
  });
  await request(app)
    .post("/api/pay/webhook")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signature)
    .send(body)
    .expect(200);

  const order = await Order.findOne({ paymentRef: args.reference });
  return { buyer, order: order! };
}

const endGroup = (code: string) => GroupBuy.updateOne({ code }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

describe("group prices", () => {
  const listing = {
    title: "Adire kaftan",
    category: "clothing",
    itemType: "kaftan",
    price: 10000,
    imageUrls: ["https://res.cloudinary.com/demo/image/upload/kaftan.jpg"],
    stockQuantity: 20,
  };

  it("must be lower than the normal price and fall as quantities grow", async () => {
    const { owner } = await createMerchant();
    const send = (groupBuy: object) =>
      request(app).post("/api/merchant/products").set(auth(owner.token)).send({ ...listing, groupBuy });

    const tooHigh = await send({ ...groupPrices, tiers: [{ minQuantity: 3, price: 12000 }] }).expect(400);
    expect(tooHigh.body.error).toBe("Group prices must be lower than the normal price.");

    const notFalling = await send({ ...groupPrices, tiers: [{ minQuantity: 3, price: 8000 }, { minQuantity: 5, price: 9000 }] }).expect(400);
    expect(notFalling.body.error).toBe("Bigger groups need lower prices.");

    const res = await send(groupPrices).expect(201);
    expect(res.body.product.groupBuy.tiers).toHaveLength(2);
  });

  it("can't start a group on a product without group prices", async () => {
    const product = await createProduct();
    const { token } = await createUser();
    const res = await request(app).post(`/api/templates/${product.id}/group-buys`).set(auth(token)).expect(400);
    expect(res.body.error).toBe("This product doesn't have group prices.");
  });
});

describe("group buys", () => {
  it("credits each buyer's savings when the group reaches a group price", async () => {
    const { product } = await groupProduct();
    const { code } = await startGroup(product.id);
    const first = await buyThroughGroup(product.id, code, 2);
    const second = await buyThroughGroup(product.id, code, 2);

    // Everyone pays the normal price up front: 2 × ₦10,000 + ₦2,000 delivery.
    expect(first.order.totalAmount).toBe(22000);
    const view = await request(app).get(`/api/group-buys/${code}`).expect(200);
    expect(view.body).toMatchObject({ status: "open", quantity: 4, buyers: 2, currentPrice: 9000, nextTier: { minQuantity: 5, quantityNeeded: 1 } });
    expect((await Fulfilment.findOne({ order: first.order._id }).lean())?.groupBuyPending).toBe(true);

    await endGroup(code);
    await closeExpiredGroupBuys();
    await closeExpiredGroupBuys();

    // ₦1,000 back on each unit, credited once.
    expect(await getAvailableCreditKobo(first.buyer.user.id)).toBe(200_000);
    expect(await getAvailableCreditKobo(second.buyer.user.id)).toBe(200_000);

    // The seller is paid on ₦18,000 of items: ₦1,800 commission, plus the ₦2,000 delivery fee.
    const parcel = await Fulfilment.findOne({ order: first.order._id }).lean();
    expect(parcel).toMatchObject({ groupDiscountKobo: 200_000, commissionKobo: 180_000, payoutKobo: 1_820_000, groupBuyPending: false });
    expect((await GroupBuy.findOne({ code }).lean())?.finalUnitPriceKobo).toBe(900_000);
  });

  it("keeps the normal price when the group doesn't reach a group price", async () => {
    const { product } = await groupProduct();
    const { code } = await startGroup(product.id);
    const only = await buyThroughGroup(product.id, code, 2);

    await endGroup(code);
    await closeExpiredGroupBuys();

    expect(await getAvailableCreditKobo(only.buyer.user.id)).toBe(0);
    expect(await Fulfilment.findOne({ order: only.order._id }).lean()).toMatchObject({ groupDiscountKobo: 0, groupBuyPending: false });
    expect((await GroupBuy.findOne({ code }).lean())?.finalUnitPriceKobo).toBe(1_000_000);
  });

  it("doesn't count parcels the seller cancelled", async () => {
    const { seller, product } = await groupProduct();
    const { code } = await startGroup(product.id);
    const first = await buyThroughGroup(product.id, code, 2);
    const second = await buyThroughGroup(product.id, code, 1);

    const cancelled = await Fulfilment.findOne({ order: second.order._id });
    await request(app)
      .post(`/api/merchant/fulfilments/${cancelled!.id}/cancel`)
      .set(auth(seller.owner.token))
      .send({ reason: "Sold out at the market" })
      .expect(200);

    await endGroup(code);
    await closeExpiredGroupBuys();

    expect((await GroupBuy.findOne({ code }).lean())?.finalQuantity).toBe(2);
    expect(await getAvailableCreditKobo(first.buyer.user.id)).toBe(0);
  });

  it("won't take new items for a group that has ended", async () => {
    const { product } = await groupProduct();
    const { code } = await startGroup(product.id);
    const buyer = await createUser();
    const add = () =>
      request(app).post("/api/cart/add").set(auth(buyer.token)).send({ templateId: product.id, size: "M", groupBuyCode: code });

    await add().expect(200);
    await endGroup(code);

    const cart = await request(app).get("/api/cart").set(auth(buyer.token)).expect(200);
    expect(cart.body.items[0]).toMatchObject({ inStock: false, unavailableReason: "group-ended" });
    await request(app).post("/api/pay/initialize").set(auth(buyer.token)).send(delivery).expect(409);

    const again = await add().expect(409);
    expect(again.body.error).toBe("This group buy has ended.");
  });

  it("takes savings already credited off a later refund", async () => {
    const { seller, product } = await groupProduct();
    const { code } = await startGroup(product.id);
    const first = await buyThroughGroup(product.id, code, 2);
    await buyThroughGroup(product.id, code, 2);
    await endGroup(code);
    await closeExpiredGroupBuys();

    const parcel = await Fulfilment.findOneAndUpdate(
      { order: first.order._id },
      { $set: { status: "delivered", deliveredAt: new Date() } },
      { new: true }
    );
    const asked = await request(app)
      .post(`/api/fulfilments/${parcel!.id}/returns`)
      .set(auth(first.buyer.token))
      .send({ items: [{ index: 0, quantity: 1 }], reason: "faulty", details: "The seam tore on the first wear", refundTo: "wallet" })
      .expect(201);
    await request(app).post(`/api/merchant/returns/${asked.body.return._id}/accept`).set(auth(seller.owner.token)).send({}).expect(200);

    // ₦2,000 of savings, plus ₦9,000 back for the returned unit (its ₦10,000 price less the ₦1,000 already credited).
    expect(await getAvailableCreditKobo(first.buyer.user.id)).toBe(1_100_000);
    // One unit kept at ₦9,000 → ₦900 commission, plus the ₦2,000 delivery fee.
    expect(await Fulfilment.findById(parcel!.id).lean()).toMatchObject({
      refundedItemsKobo: 1_000_000,
      groupDiscountKobo: 100_000,
      payoutKobo: 1_010_000,
    });
  });
});
