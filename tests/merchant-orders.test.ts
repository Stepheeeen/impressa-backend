import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/paystack", () => ({
  listBanks: vi.fn(),
  resolveBankAccount: vi.fn(),
  createTransferRecipient: vi.fn(),
  initializeTransaction: vi.fn(),
  verifyTransaction: vi.fn(),
}));

import app from "../src/app";
import Fulfilment from "../src/models/Fulfilment";
import Order from "../src/models/Order";
import { initializeTransaction, verifyTransaction } from "../src/services/paystack";
import { auth, clearDatabase, createMerchant, createProduct, createUser, startDatabase, stopDatabase } from "./helpers";

const initializeMock = vi.mocked(initializeTransaction);
const verifyMock = vi.mocked(verifyTransaction);

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  initializeMock.mockReset().mockImplementation(async ({ reference }) => ({
    authorizationUrl: "https://checkout.paystack.com/abc123",
    reference: reference ?? "ref_missing",
  }));
  verifyMock.mockReset();
});

// A paid order with one merchant parcel (2 × ₦25,000 kaftans) and one Impressa parcel (a ₦9,000 dress).
async function paidMarketplaceOrder() {
  const seller = await createMerchant({ deliveryFeeKobo: 200_000, commissionPercent: 12 });
  const kaftan = await createProduct({ title: "Adire kaftan", price: 25000, merchant: seller.merchant._id, stockQuantity: 5 });
  const dress = await createProduct({ title: "Luxury Dress", price: 9000 });
  const buyer = await createUser();
  await request(app).post("/api/cart/add").set(auth(buyer.token)).send({ templateId: kaftan.id, quantity: 2 }).expect(200);
  await request(app).post("/api/cart/add").set(auth(buyer.token)).send({ templateId: dress.id }).expect(200);

  await request(app)
    .post("/api/pay/initialize")
    .set(auth(buyer.token))
    .send({ state: "Lagos", address: "12 Admiralty Way, Lekki Phase 1", phone: "0801 234 5678" })
    .expect(200);
  const args = initializeMock.mock.calls[0][0];
  verifyMock.mockResolvedValue({
    reference: args.reference!,
    status: "success",
    amount: args.amountKobo,
    currency: "NGN",
    customer: { email: buyer.user.email },
    metadata: args.metadata,
  });
  const verified = await request(app).get(`/api/pay/verify/${args.reference}`).set(auth(buyer.token)).expect(200);

  const merchantParcel = await Fulfilment.findOne({ merchant: seller.merchant._id });
  const impressaParcel = await Fulfilment.findOne({ merchant: null });
  return { seller, buyer, orderId: verified.body.orderId as string, merchantParcel: merchantParcel!, impressaParcel: impressaParcel! };
}

const track = (token: string, fulfilmentId: string, tracking: object) =>
  request(app).patch(`/api/merchant/fulfilments/${fulfilmentId}/tracking`).set(auth(token)).send({ tracking });

describe("merchant parcels", () => {
  it("lets merchants ship and deliver their parcels, keeping the order in step", async () => {
    const admin = await createUser({ role: "admin" });
    const { seller, orderId, merchantParcel, impressaParcel } = await paidMarketplaceOrder();

    await track(seller.owner.token, merchantParcel.id, { status: "in-transit", code: "GIGL-5566-ABK" }).expect(200);
    expect((await Order.findById(orderId))?.status).toBe("paid");

    const delivered = await track(seller.owner.token, merchantParcel.id, { status: "delivered" }).expect(200);
    expect(delivered.body.status).toBe("delivered");
    expect((await Fulfilment.findById(merchantParcel.id))?.deliveredAt).toBeInstanceOf(Date);
    expect((await Order.findById(orderId))?.status).toBe("paid");

    await request(app)
      .patch(`/api/admin/fulfilments/${impressaParcel.id}`)
      .set(auth(admin.token))
      .send({ tracking: { status: "delivered" } })
      .expect(200);
    expect((await Order.findById(orderId))?.status).toBe("delivered");
  });

  it("keeps each merchant to their own parcels", async () => {
    const { merchantParcel } = await paidMarketplaceOrder();
    const other = await createMerchant();

    await track(other.owner.token, merchantParcel.id, { status: "delivered" }).expect(404);
    const list = await request(app).get("/api/merchant/fulfilments?status=all").set(auth(other.owner.token)).expect(200);
    expect(list.body).toEqual([]);
  });

  it("gives merchants the delivery details they need, without the customer's email", async () => {
    const { seller } = await paidMarketplaceOrder();

    const res = await request(app).get("/api/merchant/fulfilments").set(auth(seller.owner.token)).expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      deliveryAddress: { state: "Lagos", phone: "0801 234 5678" },
      itemsSubtotal: 50000,
      commission: 6000,
      // ₦50,000 − ₦6,000 commission + ₦2,000 delivery fee.
      payout: 46000,
      status: "paid",
    });
    expect(JSON.stringify(res.body[0])).not.toContain("@");
  });

  it("shows customers each parcel and its seller, without payout details", async () => {
    const { buyer, seller } = await paidMarketplaceOrder();

    const res = await request(app).get("/api/orders/user/me").set(auth(buyer.token)).expect(200);

    const parcels = res.body[0].fulfilments;
    expect(parcels.map((parcel: { sellerName: string }) => parcel.sellerName).sort()).toEqual(
      [seller.merchant.businessName, "Impressa"].sort()
    );
    expect(parcels[0].payout).toBeUndefined();
    expect(parcels[0].commission).toBeUndefined();
  });

  it("won't move a marketplace order backwards from the admin panel", async () => {
    const admin = await createUser({ role: "admin" });
    const { orderId } = await paidMarketplaceOrder();

    await request(app).patch(`/api/orders/${orderId}/status`).set(auth(admin.token)).send({ status: "shipped" }).expect(200);
    expect(await Fulfilment.countDocuments({ status: "shipped" })).toBe(2);

    await request(app).patch(`/api/orders/${orderId}/status`).set(auth(admin.token)).send({ status: "paid" }).expect(409);
  });

  it("summarises what a merchant has to ship and is owed", async () => {
    const { seller, merchantParcel } = await paidMarketplaceOrder();
    const summary = () => request(app).get("/api/merchant/summary").set(auth(seller.owner.token)).expect(200);

    expect((await summary()).body).toMatchObject({ toShip: 1, pendingPayout: 0 });

    await track(seller.owner.token, merchantParcel.id, { status: "delivered" }).expect(200);
    // ₦50,000 − 12% commission + ₦2,000 delivery.
    expect((await summary()).body).toMatchObject({ toShip: 0, pendingPayout: 46000 });
  });
});
