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
import Merchant from "../src/models/Merchant";
import ProductTemplate from "../src/models/ProductTemplate";
import {
  createTransferRecipient,
  initializeTransaction,
  listBanks,
  resolveBankAccount,
  verifyTransaction,
} from "../src/services/paystack";
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
const verifyMock = vi.mocked(verifyTransaction);
const delivery = { state: "Lagos", address: "12 Admiralty Way, Lekki Phase 1", phone: "0801 234 5678" };

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  vi.mocked(listBanks).mockResolvedValue([{ name: "Guaranty Trust Bank", code: "058" }]);
  vi.mocked(resolveBankAccount).mockResolvedValue({ accountName: "ADIRE HOUSE LTD", accountNumber: "0123454321" });
  vi.mocked(createTransferRecipient).mockReset().mockResolvedValue("RCP_new");
  initializeMock.mockReset().mockImplementation(async ({ reference }) => ({
    authorizationUrl: "https://checkout.paystack.com/abc123",
    reference: reference ?? "ref_missing",
  }));
  verifyMock.mockReset();
});

const application = {
  businessName: "Adire House",
  description: "Hand-dyed adire from Abeokuta",
  phone: "0803 123 4567",
  email: "sales@adirehouse.ng",
  state: "Ogun",
  address: "12 Itoku Market Road, Abeokuta",
  bankCode: "058",
  accountNumber: "0123454321",
  idDocumentPublicId: "merchant-ids/licence-front",
  idDocumentFormat: "jpg",
  deliveryFee: 2000,
};

const newProduct = {
  title: "Adire kaftan",
  category: "Clothing",
  itemType: "kaftan",
  description: "Indigo adire, hand-dyed",
  price: 25000,
  imageUrls: ["https://res.cloudinary.com/dlyu92juc/image/upload/kaftan.jpg"],
  sizes: ["M", "L"],
  stockQuantity: 5,
};

describe("merchant applications", () => {
  it("verifies the bank account and waits for approval", async () => {
    const { token } = await createUser();

    const res = await request(app).post("/api/merchant/application").set(auth(token)).send(application).expect(201);

    expect(res.body.merchant).toMatchObject({
      status: "pending",
      deliveryFee: 2000,
      commissionPercent: 10,
      bank: { accountName: "ADIRE HOUSE LTD", accountNumberLast4: "4321" },
    });
    expect(res.body.merchant.bank.recipientCode).toBeUndefined();
    expect(createTransferRecipient).toHaveBeenCalledWith({ name: "ADIRE HOUSE LTD", accountNumber: "0123454321", bankCode: "058" });
    expect((await Merchant.findOne())?.bank.recipientCode).toBe("RCP_new");
  });

  it("won't take a second application while one is being reviewed", async () => {
    const { token } = await createUser();
    await request(app).post("/api/merchant/application").set(auth(token)).send(application).expect(201);
    const res = await request(app).post("/api/merchant/application").set(auth(token)).send(application).expect(409);
    expect(res.body.error).toBe("Your application is already being reviewed.");
  });

  it("lets a rejected applicant apply again", async () => {
    const { owner } = await createMerchant({ status: "rejected" });
    const res = await request(app).post("/api/merchant/application").set(auth(owner.token)).send(application).expect(201);
    expect(res.body.merchant.status).toBe("pending");
  });

  it("only accepts ID documents uploaded privately", async () => {
    const { token } = await createUser();
    await request(app)
      .post("/api/merchant/application")
      .set(auth(token))
      .send({ ...application, idDocumentPublicId: "products/licence-front" })
      .expect(400);
  });

  it("signs private ID uploads", async () => {
    const { token } = await createUser();
    const res = await request(app).post("/api/merchant/id-upload-signature").set(auth(token)).expect(200);
    expect(res.body).toMatchObject({ type: "private", folder: "merchant-ids", apiKey: "cloudinary-test-key" });
    expect(res.body.signature).toMatch(/^[a-f0-9]{40}$/);
  });
});

describe("selling", () => {
  it("only approved merchants can add products", async () => {
    const { owner } = await createMerchant({ status: "pending" });
    const res = await request(app).post("/api/merchant/products").set(auth(owner.token)).send(newProduct).expect(403);
    expect(res.body.error).toBe("Your merchant application hasn't been approved yet.");
  });

  it("hides a suspended merchant's products and shows them again when reinstated", async () => {
    const admin = await createUser({ role: "admin" });
    const { owner, merchant } = await createMerchant({ status: "pending" });
    await request(app).post(`/api/admin/merchants/${merchant.id}/approve`).set(auth(admin.token)).expect(200);
    const created = await request(app).post("/api/merchant/products").set(auth(owner.token)).send(newProduct).expect(201);
    const productId = created.body.product._id;

    const titles = async (token?: string) => {
      const req = request(app).get("/api/templates");
      const res = token ? await req.set(auth(token)) : await req;
      return res.body.map((product: { title: string }) => product.title);
    };
    expect(await titles()).toContain("Adire kaftan");

    await request(app).post(`/api/admin/merchants/${merchant.id}/suspend`).set(auth(admin.token)).send({ reason: "Repeated late deliveries" }).expect(200);
    expect(await titles()).not.toContain("Adire kaftan");
    expect(await titles(admin.token)).toContain("Adire kaftan");

    const customer = await createUser();
    await request(app).post("/api/cart/add").set(auth(customer.token)).send({ templateId: productId }).expect(404);

    await request(app).post(`/api/admin/merchants/${merchant.id}/reinstate`).set(auth(admin.token)).expect(200);
    expect(await titles()).toContain("Adire kaftan");
  });

  it("lets merchants manage only their own products", async () => {
    const { merchant } = await createMerchant();
    const other = await createMerchant();
    const product = await createProduct({ merchant: merchant._id, stockQuantity: 3 });

    await request(app).put(`/api/merchant/products/${product.id}`).set(auth(other.owner.token)).send(newProduct).expect(404);
    await request(app).patch(`/api/merchant/products/${product.id}/stock`).set(auth(other.owner.token)).send({ stockQuantity: 0 }).expect(404);
  });

  it("lets admins hide a product", async () => {
    const admin = await createUser({ role: "admin" });
    const product = await createProduct();

    await request(app).patch(`/api/admin/products/${product.id}/visibility`).set(auth(admin.token)).send({ hidden: true }).expect(200);

    await request(app).get(`/api/templates/${product.id}`).expect(404);
    await request(app).get(`/api/templates/${product.id}`).set(auth(admin.token)).expect(200);
  });
});

describe("marketplace checkout", () => {
  async function marketplaceCart(stockQuantity = 5) {
    const { merchant } = await createMerchant({ deliveryFeeKobo: 200_000, commissionPercent: 12 });
    const kaftan = await createProduct({ title: "Adire kaftan", price: 25000, merchant: merchant._id, stockQuantity });
    const dress = await createProduct({ title: "Luxury Dress", price: 9000 });
    const buyer = await createUser();
    await request(app).post("/api/cart/add").set(auth(buyer.token)).send({ templateId: kaftan.id, quantity: 2 }).expect(200);
    await request(app).post("/api/cart/add").set(auth(buyer.token)).send({ templateId: dress.id, quantity: 1 }).expect(200);
    return { merchant, kaftan, dress, buyer };
  }

  it("charges each seller's delivery fee and splits the paid order into parcels", async () => {
    const { merchant, kaftan, buyer } = await marketplaceCart();

    const quote = await request(app).post("/api/pay/quote").set(auth(buyer.token)).send({}).expect(200);
    // ₦50,000 + ₦9,000 of items; ₦2,000 merchant delivery + ₦1,500 Impressa delivery.
    expect(quote.body).toMatchObject({ subtotal: 59000, deliveryFee: 3500, total: 62500 });
    expect(quote.body.sellers).toHaveLength(2);

    await request(app).post("/api/pay/initialize").set(auth(buyer.token)).send(delivery).expect(200);
    const args = initializeMock.mock.calls[0][0];
    const paid = { reference: args.reference!, status: "success", amount: args.amountKobo, currency: "NGN", customer: { email: buyer.user.email }, metadata: args.metadata };
    verifyMock.mockResolvedValue(paid);
    const { body, signature } = signedWebhook({ event: "charge.success", data: paid });

    await Promise.all([
      request(app).get(`/api/pay/verify/${paid.reference}`).set(auth(buyer.token)),
      request(app).post("/api/pay/webhook").set("Content-Type", "application/json").set("x-paystack-signature", signature).send(body),
    ]);

    const fulfilments = await Fulfilment.find().lean();
    expect(fulfilments).toHaveLength(2);
    const merchantParcel = fulfilments.find((f) => String(f.merchant) === merchant.id);
    expect(merchantParcel).toMatchObject({
      itemsSubtotalKobo: 5_000_000,
      commissionPercent: 12,
      commissionKobo: 600_000,
      deliveryFeeKobo: 200_000,
      payoutKobo: 4_600_000,
    });
    expect(fulfilments.find((f) => f.merchant === null)?.payout.status).toBe("not-applicable");
    expect((await ProductTemplate.findById(kaftan.id))?.stockQuantity).toBe(3);
  });

  it("won't add more to the cart than the merchant has in stock", async () => {
    const { merchant } = await createMerchant();
    const kaftan = await createProduct({ price: 25000, merchant: merchant._id, stockQuantity: 1 });
    const buyer = await createUser();

    const res = await request(app).post("/api/cart/add").set(auth(buyer.token)).send({ templateId: kaftan.id, quantity: 2 }).expect(400);
    expect(res.body.error).toBe("Only 1 left in stock.");
  });

  it("flags a parcel whose items sold out before payment finished", async () => {
    const { kaftan, buyer } = await marketplaceCart(2);
    await request(app).post("/api/pay/initialize").set(auth(buyer.token)).send(delivery).expect(200);
    // Someone else buys one while this customer is on Paystack.
    await ProductTemplate.updateOne({ _id: kaftan._id }, { $set: { stockQuantity: 1 } });

    const args = initializeMock.mock.calls[0][0];
    verifyMock.mockResolvedValue({ reference: args.reference!, status: "success", amount: args.amountKobo, currency: "NGN", customer: { email: buyer.user.email }, metadata: args.metadata });
    await request(app).get(`/api/pay/verify/${args.reference}`).set(auth(buyer.token)).expect(200);

    const parcel = await Fulfilment.findOne({ merchant: { $ne: null } }).lean();
    expect(parcel?.needsAttention).toBe(true);
    expect(parcel?.items[0].oversold).toBe(true);
    expect((await ProductTemplate.findById(kaftan.id))?.stockQuantity).toBe(1);
  });
});
