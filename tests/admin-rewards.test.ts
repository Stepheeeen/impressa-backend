import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/app";
import CouponRedemption from "../src/models/CouponRedemption";
import WalletTransaction from "../src/models/WalletTransaction";
import { holdWalletCredit } from "../src/services/wallet";
import { auth, clearDatabase, createOrder, createUser, startDatabase, stopDatabase } from "./helpers";

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(clearDatabase);

describe("reward settings", () => {
  it("are only available to admins", async () => {
    const customer = await createUser();
    await request(app).get("/api/admin/rewards/settings").set(auth(customer.token)).expect(403);
  });

  it("are edited in naira and validated", async () => {
    const admin = await createUser({ role: "admin" });
    const current = (await request(app).get("/api/admin/rewards/settings").set(auth(admin.token)).expect(200)).body;
    expect(current).toMatchObject({
      creditExpiryDays: 90,
      cashbackPercent: 2,
      cashbackMax: 2000,
      checkInRewards: [20, 20, 30, 30, 50, 50, 100],
      gamesMonthlyBudget: 200000,
    });

    const invalid = await request(app)
      .put("/api/admin/rewards/settings")
      .set(auth(admin.token))
      .send({ ...current, cashbackPercent: 150 })
      .expect(400);
    expect(invalid.body.error).toBe("Cashback can't be more than 100%.");

    const saved = await request(app)
      .put("/api/admin/rewards/settings")
      .set(auth(admin.token))
      .send({ ...current, cashbackMax: 2500, walletUsageMode: "items-only" })
      .expect(200);
    expect(saved.body.settings).toMatchObject({ cashbackMax: 2500, walletUsageMode: "items-only" });
  });
});

describe("wallet adjustments", () => {
  it("need a reason and record which admin made them", async () => {
    const admin = await createUser({ role: "admin" });
    const { user } = await createUser();
    const adjust = (body: object) =>
      request(app).post(`/api/admin/wallets/${user.id}/adjustments`).set(auth(admin.token)).send(body);

    expect((await adjust({ amount: 500, reason: "ok" }).expect(400)).body.error).toBe("Give a reason of at least 5 characters.");
    expect((await adjust({ amount: 500, reason: "Late delivery goodwill" }).expect(201)).body.balance).toBe(500);
    expect((await adjust({ amount: -1000, reason: "Duplicate goodwill" }).expect(400)).body.error).toBe(
      "The customer doesn't have that much credit."
    );
    expect((await adjust({ amount: -200, reason: "Partial correction" }).expect(201)).body.balance).toBe(300);

    const creditEntry = await WalletTransaction.findOne({ kind: "credit" }).lean();
    expect(String(creditEntry?.actor)).toBe(admin.user.id);
    expect(creditEntry?.note).toBe("Late delivery goodwill");
  });

  it("finds a customer's wallet by email", async () => {
    const admin = await createUser({ role: "admin" });
    const { user } = await createUser({ email: "chioma@example.com" });
    await request(app)
      .post(`/api/admin/wallets/${user.id}/adjustments`)
      .set(auth(admin.token))
      .send({ amount: 500, reason: "Welcome credit" })
      .expect(201);

    const res = await request(app).get("/api/admin/wallets?email=CHIOMA@example.com").set(auth(admin.token)).expect(200);
    expect(res.body).toMatchObject({ customer: { email: "chioma@example.com" }, balance: 500 });
    expect(res.body.transactions[0]).toMatchObject({ note: "Welcome credit", actor: admin.user.email });
  });

  it("reports no reconciliation mismatches for a healthy ledger", async () => {
    const admin = await createUser({ role: "admin" });
    const { user } = await createUser();
    await request(app)
      .post(`/api/admin/wallets/${user.id}/adjustments`)
      .set(auth(admin.token))
      .send({ amount: 1000, reason: "Goodwill credit" })
      .expect(201);
    await holdWalletCredit({ userId: user.id, amountKobo: 30_000, reference: "ref_checkout" });

    const res = await request(app).get("/api/admin/wallets/reconciliation").set(auth(admin.token)).expect(200);
    expect(res.body.mismatches).toEqual([]);
  });
});

describe("coupons", () => {
  const createCoupon = (token: string, body: object) =>
    request(app).post("/api/admin/coupons").set(auth(token)).send(body);

  it("rejects a duplicate code", async () => {
    const admin = await createUser({ role: "admin" });
    await createCoupon(admin.token, { code: "save10", type: "percent", percentOff: 10 }).expect(201);

    const res = await createCoupon(admin.token, { code: "SAVE10", type: "percent", percentOff: 20 }).expect(409);
    expect(res.body.error).toBe("A coupon with that code already exists.");
  });

  it("requires the discount for its type", async () => {
    const admin = await createUser({ role: "admin" });
    const res = await createCoupon(admin.token, { code: "NOAMOUNT", type: "fixed", amountOff: "" }).expect(400);
    expect(res.body.error).toBe("Enter the amount off.");
  });

  it("can't be deleted once used", async () => {
    const admin = await createUser({ role: "admin" });
    const used = (await createCoupon(admin.token, { code: "USED", type: "fixed", amountOff: 500 }).expect(201)).body.coupon;
    await CouponRedemption.create({ coupon: used._id, user: admin.user._id, reference: "ref_used", discountKobo: 50_000 });

    await request(app).delete(`/api/admin/coupons/${used._id}`).set(auth(admin.token)).expect(409);

    const unused = (await createCoupon(admin.token, { code: "UNUSED", type: "fixed", amountOff: 500 }).expect(201)).body.coupon;
    await request(app).delete(`/api/admin/coupons/${unused._id}`).set(auth(admin.token)).expect(200);
  });
});

describe("rewards summary", () => {
  it("shows this month's game rewards against the budget", async () => {
    const admin = await createUser({ role: "admin" });
    const customer = await createUser();
    await createOrder(customer.user._id, { status: "delivered" });
    await request(app).post("/api/rewards/check-in").set(auth(customer.token)).expect(201);

    const res = await request(app).get("/api/admin/rewards/summary").set(auth(admin.token)).expect(200);
    expect(res.body).toMatchObject({ gamesSpentThisMonth: 20, gamesMonthlyBudget: 200000, outstandingCredit: 20 });
  });
});
