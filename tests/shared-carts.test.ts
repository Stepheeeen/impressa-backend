import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/paystack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/paystack")>();
  return { ...actual, initializeTransaction: vi.fn(), verifyTransaction: vi.fn(), refundTransaction: vi.fn() };
});

import app from "../src/app";
import Fulfilment from "../src/models/Fulfilment";
import Order from "../src/models/Order";
import SharedCheckout from "../src/models/SharedCheckout";
import { cancelFulfilment } from "../src/services/fulfilments";
import { initializeTransaction, refundTransaction } from "../src/services/paystack";
import { expireSharedCheckouts } from "../src/services/sharedCarts";
import { auth, clearDatabase, createProduct, createUser, signedWebhook, startDatabase, stopDatabase } from "./helpers";

const initializeMock = vi.mocked(initializeTransaction);
const refundMock = vi.mocked(refundTransaction);

const delivery = { state: "Lagos", address: "12 Admiralty Way, Lekki Phase 1", phone: "0801 234 5678" };

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

type Person = Awaited<ReturnType<typeof createUser>>;

// An owner and a friend sharing a cart, and a ₦9,000 Impressa product (₦1,500 delivery).
async function sharedCart() {
  const owner = await createUser();
  const friend = await createUser();
  const created = await request(app).post("/api/shared-carts").set(auth(owner.token)).send({ name: "Owambe outfits" }).expect(201);
  const cartId = created.body._id as string;
  await request(app).post("/api/shared-carts/join").set(auth(friend.token)).send({ code: created.body.code }).expect(200);

  const product = await createProduct({ price: 9000 });
  const add = (who: Person, quantity = 1) =>
    request(app).post(`/api/shared-carts/${cartId}/items`).set(auth(who.token)).send({ templateId: product.id, quantity, size: "M" });
  const checkout = (body: object) =>
    request(app).post(`/api/shared-carts/${cartId}/checkout`).set(auth(owner.token)).send({ ...delivery, ...body });
  return { owner, friend, cartId, product, add, checkout };
}

// Starts paying a share and returns the Paystack transaction that would succeed.
async function startPaying(cartId: string, who: Person) {
  initializeMock.mockClear();
  await request(app).post(`/api/shared-carts/${cartId}/checkout/pay`).set(auth(who.token)).send({}).expect(200);
  const args = initializeMock.mock.calls[0][0];
  return {
    reference: args.reference!,
    amountKobo: args.amountKobo,
    transaction: { reference: args.reference, status: "success", amount: args.amountKobo, currency: "NGN", customer: { email: who.user.email }, metadata: args.metadata },
  };
}

async function paystackReports(transaction: object) {
  const { body, signature } = signedWebhook({ event: "charge.success", data: transaction });
  await request(app).post("/api/pay/webhook").set("Content-Type", "application/json").set("x-paystack-signature", signature).send(body).expect(200);
}

async function payShare(cartId: string, who: Person) {
  const payment = await startPaying(cartId, who);
  await paystackReports(payment.transaction);
  return payment;
}

describe("shared carts", () => {
  it("lets every member change any item and keeps everyone else out", async () => {
    const { owner, friend, cartId, add } = await sharedCart();
    const added = await add(owner).expect(200);
    const itemId = added.body.items[0].id;

    const changed = await request(app).patch(`/api/shared-carts/${cartId}/items/${itemId}`).set(auth(friend.token)).send({ quantity: 3 }).expect(200);
    expect(changed.body.items[0]).toMatchObject({ quantity: 3, addedBy: { userId: owner.user.id } });
    expect(changed.body.members).toHaveLength(2);

    const stranger = await createUser();
    await request(app).get(`/api/shared-carts/${cartId}`).set(auth(stranger.token)).expect(404);
    await request(app).delete(`/api/shared-carts/${cartId}/items/${itemId}`).set(auth(stranger.token)).expect(404);
  });

  it("gives a member's items to the owner when they leave", async () => {
    const { owner, friend, cartId, add } = await sharedCart();
    await add(friend).expect(200);
    await request(app).post(`/api/shared-carts/${cartId}/leave`).set(auth(friend.token)).expect(200);

    const cart = await request(app).get(`/api/shared-carts/${cartId}`).set(auth(owner.token)).expect(200);
    expect(cart.body.members).toHaveLength(1);
    expect(cart.body.items[0].addedBy.userId).toBe(owner.user.id);
  });

  it("works out each person's share for every way of paying", async () => {
    const { owner, friend, cartId, add } = await sharedCart();
    await add(owner, 2).expect(200);
    await add(friend, 1).expect(200);
    const quote = (body: object) => request(app).post(`/api/shared-carts/${cartId}/quote`).set(auth(owner.token)).send(body).expect(200);

    // ₦27,000 of items plus ₦1,500 delivery.
    const ownItems = await quote({ mode: "own-items" });
    expect(ownItems.body.shares.map((s: { amount: number }) => s.amount)).toEqual([18750, 9750]);

    const even = await quote({ mode: "split-evenly" });
    expect(even.body.shares.map((s: { amount: number }) => s.amount)).toEqual([14250, 14250]);

    const onePayer = await quote({ mode: "one-payer", payerId: friend.user.id });
    expect(onePayer.body.shares).toEqual([expect.objectContaining({ userId: friend.user.id, amount: 28500 })]);

    const coupon = await quote({ mode: "split-evenly", couponCode: "WELCOME10" });
    expect(coupon.body.couponError).toBe("Coupons can only be used when the cart owner pays for everything.");
  });
});

describe("paying for a shared cart", () => {
  it("places one order once everyone has paid their share", async () => {
    const { owner, friend, cartId, add, checkout } = await sharedCart();
    await add(owner).expect(200);
    await add(friend).expect(200);

    const started = await checkout({ mode: "split-evenly" }).expect(201);
    expect(started.body.checkout.shares.map((s: { amount: number }) => s.amount)).toEqual([9750, 9750]);
    // Items are locked while people pay.
    const locked = await add(friend).expect(409);
    expect(locked.body.error).toMatch(/^Items can't change while everyone is paying/);

    const ownerPayment = await payShare(cartId, owner);
    expect(ownerPayment.amountKobo).toBe(975_000);
    expect(await Order.countDocuments()).toBe(0);

    await payShare(cartId, friend);
    const orders = await Order.find().lean();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ totalAmount: 19500, user: owner.user._id });
    expect(orders[0].payers).toHaveLength(2);

    const cart = await request(app).get(`/api/shared-carts/${cartId}`).set(auth(friend.token)).expect(200);
    expect(cart.body).toMatchObject({ status: "open", items: [], checkout: null });

    const friendOrders = await request(app).get("/api/orders/user/me").set(auth(friend.token)).expect(200);
    expect(friendOrders.body).toEqual([expect.objectContaining({ sharedWithYou: true })]);
  });

  it("lets one member pay for everything", async () => {
    const { owner, friend, cartId, add, checkout } = await sharedCart();
    await add(owner).expect(200);
    await checkout({ mode: "one-payer", payerId: friend.user.id }).expect(201);

    await request(app).post(`/api/shared-carts/${cartId}/checkout/pay`).set(auth(owner.token)).send({}).expect(403);
    const payment = await payShare(cartId, friend);

    expect(payment.amountKobo).toBe(1_050_000);
    const order = await Order.findOne().lean();
    expect(order).toMatchObject({ user: owner.user._id, payers: [expect.objectContaining({ user: friend.user._id, cardPaidKobo: 1_050_000 })] });
  });

  it("refunds a second payment for a share that's already paid", async () => {
    const { owner, cartId, add, checkout } = await sharedCart();
    await add(owner).expect(200);
    await checkout({ mode: "one-payer" }).expect(201);

    const first = await startPaying(cartId, owner);
    const second = await startPaying(cartId, owner);
    await paystackReports(first.transaction);
    await paystackReports(second.transaction);
    await paystackReports(second.transaction);

    expect(await Order.countDocuments()).toBe(1);
    expect(refundMock).toHaveBeenCalledTimes(1);
    expect(refundMock).toHaveBeenCalledWith(expect.objectContaining({ reference: second.reference, amountKobo: 1_050_000 }));
  });

  it("refunds whoever paid when the others don't pay in time", async () => {
    const { owner, friend, cartId, add, checkout } = await sharedCart();
    await add(owner).expect(200);
    await add(friend).expect(200);
    await checkout({ mode: "split-evenly" }).expect(201);
    const ownerPayment = await payShare(cartId, owner);

    await SharedCheckout.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await expireSharedCheckouts();

    expect(refundMock).toHaveBeenCalledWith(expect.objectContaining({ reference: ownerPayment.reference, amountKobo: 975_000 }));
    expect(await Order.countDocuments()).toBe(0);
    const cart = await request(app).get(`/api/shared-carts/${cartId}`).set(auth(owner.token)).expect(200);
    expect(cart.body).toMatchObject({ status: "open", checkout: null });
    expect(cart.body.items).toHaveLength(2);
  });

  it("shares a later refund between the people who paid", async () => {
    const { owner, friend, cartId, add, checkout } = await sharedCart();
    await add(owner).expect(200);
    await add(friend).expect(200);
    await checkout({ mode: "split-evenly" }).expect(201);
    const ownerPayment = await payShare(cartId, owner);
    const friendPayment = await payShare(cartId, friend);

    const parcel = await Fulfilment.findOne();
    await cancelFulfilment(parcel!.id, { reason: "Out of stock at the warehouse" });

    // ₦18,000 of items and ₦1,500 delivery, half back to each card.
    expect(refundMock).toHaveBeenCalledTimes(2);
    expect(refundMock).toHaveBeenCalledWith(expect.objectContaining({ reference: ownerPayment.reference, amountKobo: 975_000 }));
    expect(refundMock).toHaveBeenCalledWith(expect.objectContaining({ reference: friendPayment.reference, amountKobo: 975_000 }));
  });
});
