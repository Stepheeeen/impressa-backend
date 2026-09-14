import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/paystack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/paystack")>();
  return { ...actual, initiateTransfer: vi.fn(), verifyTransfer: vi.fn(), refundTransaction: vi.fn() };
});

import app from "../src/app";
import Fulfilment from "../src/models/Fulfilment";
import Order from "../src/models/Order";
import ProductTemplate from "../src/models/ProductTemplate";
import ReturnRequest from "../src/models/ReturnRequest";
import { PaystackRequestError, refundTransaction } from "../src/services/paystack";
import { closeUnescalatedReturns, escalateOverdueReturns } from "../src/services/returns";
import { getAvailableCreditKobo } from "../src/services/wallet";
import { auth, clearDatabase, createMerchant, createParcel, createUser, startDatabase, stopDatabase } from "./helpers";

const refundMock = vi.mocked(refundTransaction);

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  refundMock.mockReset().mockResolvedValue({ status: "pending" });
});

const returnOne = { items: [{ index: 0, quantity: 1 }], reason: "faulty", details: "The seam tore on the first wear", refundTo: "wallet" };

// A delivered parcel of 2 × ₦25,000 from a merchant (10% commission, ₦2,000 delivery → ₦47,000 payout).
async function deliveredOrder(options: Parameters<typeof createParcel>[0] extends infer O ? Partial<O> : never = {}) {
  const seller = await createMerchant();
  const customer = await createUser();
  const parcel = await createParcel({ merchant: seller.merchant, customerId: customer.user._id, ...options });
  const askForReturn = (body: object = returnOne) =>
    request(app).post(`/api/fulfilments/${parcel.fulfilment.id}/returns`).set(auth(customer.token)).send(body);
  return { seller, customer, ...parcel, askForReturn };
}

describe("requesting a return", () => {
  it("holds the merchant's payout while the return is decided", async () => {
    const { fulfilment, askForReturn } = await deliveredOrder();

    const res = await askForReturn().expect(201);

    expect(res.body.return).toMatchObject({ status: "requested", returnShippingPaidBy: "merchant", itemsValue: 25000 });
    expect((await Fulfilment.findById(fulfilment.id))?.payout.status).toBe("held");
  });

  it("closes returns after the returns window", async () => {
    const { askForReturn } = await deliveredOrder({ deliveredDaysAgo: 8 });
    const res = await askForReturn().expect(409);
    expect(res.body.error).toMatch(/^Returns for this order closed on/);
  });

  it("won't return more than was bought or allow two open returns", async () => {
    const { askForReturn } = await deliveredOrder();

    await askForReturn({ ...returnOne, items: [{ index: 0, quantity: 3 }] }).expect(400);
    await askForReturn().expect(201);
    const second = await askForReturn().expect(409);
    expect(second.body.error).toBe("You already have a return in progress for this parcel.");
  });

  it("makes change-of-mind returns the customer's delivery cost", async () => {
    const { askForReturn } = await deliveredOrder();
    const res = await askForReturn({ ...returnOne, reason: "changed-mind" }).expect(201);
    expect(res.body.return.returnShippingPaidBy).toBe("customer");
  });
});

describe("deciding a return", () => {
  it("refunds to the wallet and takes the returned item out of the payout when the merchant accepts", async () => {
    const { seller, customer, fulfilment, askForReturn } = await deliveredOrder();
    const { body } = await askForReturn().expect(201);

    await request(app).post(`/api/merchant/returns/${body.return._id}/accept`).set(auth(seller.owner.token)).send({ note: "Sorry about that" }).expect(200);

    expect(await getAvailableCreditKobo(customer.user.id)).toBe(2_500_000);
    const updated = await Fulfilment.findById(fulfilment.id).lean();
    // ₦25,000 kept − 10% commission + ₦2,000 delivery.
    expect(updated).toMatchObject({ refundedItemsKobo: 2_500_000, payoutKobo: 2_450_000 });
    expect(updated?.payout.status).toBe("pending");
    expect(updated?.items[0].returnedQuantity).toBe(1);
  });

  it("refunds only what was paid after a coupon", async () => {
    // ₦50,000 of items with a ₦10,000 coupon: the customer paid 80% of each item's price.
    const { seller, customer, askForReturn } = await deliveredOrder({
      pricing: { subtotalKobo: 5_000_000, discountKobo: 1_000_000, walletAppliedKobo: 0, cardPaidKobo: 4_200_000 },
    });
    const { body } = await askForReturn().expect(201);

    await request(app).post(`/api/merchant/returns/${body.return._id}/accept`).set(auth(seller.owner.token)).send({}).expect(200);

    expect(await getAvailableCreditKobo(customer.user.id)).toBe(2_000_000);
  });

  it("refunds to the card up to what the card paid, and the rest to the wallet", async () => {
    // The customer paid ₦10,000 by card and the rest with wallet credit.
    const { seller, customer, order, askForReturn } = await deliveredOrder({
      pricing: { subtotalKobo: 5_000_000, discountKobo: 0, walletAppliedKobo: 4_200_000, cardPaidKobo: 1_000_000 },
    });
    const { body } = await askForReturn({ ...returnOne, refundTo: "card" }).expect(201);

    await request(app).post(`/api/merchant/returns/${body.return._id}/accept`).set(auth(seller.owner.token)).send({}).expect(200);

    expect(refundMock).toHaveBeenCalledWith(expect.objectContaining({ reference: order.paymentRef, amountKobo: 1_000_000 }));
    expect(await getAvailableCreditKobo(customer.user.id)).toBe(1_500_000);
    expect((await Order.findById(order.id))?.cardRefundedKobo).toBe(1_000_000);
    expect((await ReturnRequest.findById(body.return._id))?.refund).toMatchObject({ cardKobo: 1_000_000, walletKobo: 1_500_000 });
  });

  it("refunds to the wallet if the card refund fails", async () => {
    refundMock.mockRejectedValue(new PaystackRequestError("Transaction has been fully reversed"));
    const { seller, customer, order, askForReturn } = await deliveredOrder();
    const { body } = await askForReturn({ ...returnOne, refundTo: "card" }).expect(201);

    await request(app).post(`/api/merchant/returns/${body.return._id}/accept`).set(auth(seller.owner.token)).send({}).expect(200);

    expect(await getAvailableCreditKobo(customer.user.id)).toBe(2_500_000);
    expect((await Order.findById(order.id))?.cardRefundedKobo).toBe(0);
  });

  it("lets a customer ask Impressa to review a declined return", async () => {
    const admin = await createUser({ role: "admin" });
    const { seller, customer, askForReturn } = await deliveredOrder();
    const { body } = await askForReturn().expect(201);
    const returnId = body.return._id;

    await request(app).post(`/api/merchant/returns/${returnId}/reject`).set(auth(seller.owner.token)).send({ note: "The item was worn and washed" }).expect(200);
    await request(app).post(`/api/returns/${returnId}/escalate`).set(auth(customer.token)).send({ note: "It tore the first time I wore it" }).expect(200);

    const queue = await request(app).get("/api/admin/returns?status=escalated").set(auth(admin.token)).expect(200);
    expect(queue.body.map((r: { _id: string }) => r._id)).toEqual([returnId]);

    await request(app).post(`/api/admin/returns/${returnId}/approve`).set(auth(admin.token)).send({ note: "Photos show a manufacturing fault" }).expect(200);
    expect(await getAvailableCreditKobo(customer.user.id)).toBe(2_500_000);
  });

  it("sends returns the merchant ignores to admin, and closes declined ones nobody escalated", async () => {
    const { seller, fulfilment, askForReturn } = await deliveredOrder();
    const { body } = await askForReturn().expect(201);

    await ReturnRequest.updateOne({ _id: body.return._id }, { $set: { merchantRespondBy: new Date(Date.now() - 1000) } });
    expect(await escalateOverdueReturns()).toBe(1);
    expect((await ReturnRequest.findById(body.return._id))?.status).toBe("escalated");

    // A different parcel whose return the merchant declined three days ago.
    const other = await deliveredOrder();
    const second = await other.askForReturn().expect(201);
    await request(app).post(`/api/merchant/returns/${second.body.return._id}/reject`).set(auth(other.seller.owner.token)).send({ note: "The item was worn and washed" }).expect(200);
    await ReturnRequest.updateOne({ _id: second.body.return._id }, { $set: { customerEscalateBy: new Date(Date.now() - 1000) } });

    expect(await closeUnescalatedReturns()).toBe(1);
    expect((await ReturnRequest.findById(second.body.return._id))?.status).toBe("declined");
    expect((await Fulfilment.findById(other.fulfilment.id))?.payout.status).toBe("pending");
    // The first parcel is still held because its return is with admin.
    expect((await Fulfilment.findById(fulfilment.id))?.payout.status).toBe("held");
    void seller;
  });
});

describe("cancelling a parcel", () => {
  it("refunds the customer to their card and puts the stock back", async () => {
    const { seller, order, fulfilment, product } = await deliveredOrder({ status: "paid" });

    await request(app)
      .post(`/api/merchant/fulfilments/${fulfilment.id}/cancel`)
      .set(auth(seller.owner.token))
      .send({ reason: "Out of this fabric" })
      .expect(200);

    // Both items plus the ₦2,000 delivery fee.
    expect(refundMock).toHaveBeenCalledWith(expect.objectContaining({ reference: order.paymentRef, amountKobo: 5_200_000 }));
    expect(await Fulfilment.findById(fulfilment.id)).toMatchObject({ status: "cancelled" });
    expect((await ProductTemplate.findById(product.id))?.stockQuantity).toBe(12);
  });

  it("can't cancel a parcel that has shipped", async () => {
    const { seller, fulfilment } = await deliveredOrder({ status: "shipped" });
    await request(app).post(`/api/merchant/fulfilments/${fulfilment.id}/cancel`).set(auth(seller.owner.token)).send({ reason: "Changed my mind" }).expect(409);
  });
});
