import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/paystack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/paystack")>();
  return { ...actual, initiateTransfer: vi.fn(), verifyTransfer: vi.fn(), refundTransaction: vi.fn() };
});

import app from "../src/app";
import Fulfilment from "../src/models/Fulfilment";
import Payout from "../src/models/Payout";
import ReturnRequest from "../src/models/ReturnRequest";
import { initiateTransfer, PaystackRequestError, verifyTransfer } from "../src/services/paystack";
import { createDuePayouts, retryPayouts } from "../src/services/payouts";
import {
  auth,
  clearDatabase,
  createMerchant,
  createParcel,
  createUser,
  setMarketplaceSettings,
  signedWebhook,
  startDatabase,
  stopDatabase,
} from "./helpers";

const initiateMock = vi.mocked(initiateTransfer);
const verifyMock = vi.mocked(verifyTransfer);

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  initiateMock.mockReset().mockResolvedValue({ status: "pending", transferCode: "TRF_test" });
  verifyMock.mockReset().mockResolvedValue(null);
  await setMarketplaceSettings({ payoutsEnabled: true });
});

// Each parcel: 2 × ₦25,000, 10% commission, ₦2,000 delivery → ₦47,000 payout.
async function deliveredParcels(count: number, deliveredDaysAgo = 8) {
  const { merchant } = await createMerchant();
  const customer = await createUser();
  const parcels = [];
  for (let i = 0; i < count; i++) {
    parcels.push(await createParcel({ merchant, customerId: customer.user._id, deliveredDaysAgo }));
  }
  return { merchant, customer, parcels };
}

describe("merchant payouts", () => {
  it("pays a merchant once the returns window has passed, in one transfer", async () => {
    const { merchant, parcels } = await deliveredParcels(2);

    expect(await createDuePayouts()).toBe(1);

    expect(initiateMock).toHaveBeenCalledTimes(1);
    const transfer = initiateMock.mock.calls[0][0];
    expect(transfer).toMatchObject({ amountKobo: 9_400_000, recipientCode: merchant.bank.recipientCode });
    expect(transfer.reference).toMatch(/^payout_[a-f0-9]{24}$/);
    expect(await Fulfilment.countDocuments({ "payout.status": "processing" })).toBe(2);

    const { body, signature } = signedWebhook({
      event: "transfer.success",
      data: { reference: transfer.reference, transfer_code: "TRF_test", status: "success" },
    });
    await request(app).post("/api/pay/webhook").set("Content-Type", "application/json").set("x-paystack-signature", signature).send(body).expect(200);

    expect((await Payout.findOne())?.status).toBe("paid");
    expect(await Fulfilment.countDocuments({ _id: { $in: parcels.map((p) => p.fulfilment._id) }, "payout.status": "paid" })).toBe(2);
  });

  it("waits while the returns window is open", async () => {
    await deliveredParcels(1, 3);
    expect(await createDuePayouts()).toBe(0);
    expect(initiateMock).not.toHaveBeenCalled();
  });

  it("holds a parcel with a return still being decided", async () => {
    const { merchant, customer, parcels } = await deliveredParcels(1);
    await ReturnRequest.create({
      fulfilment: parcels[0].fulfilment._id,
      order: parcels[0].order._id,
      user: customer.user._id,
      merchant: merchant._id,
      items: [{ index: 0, title: "Adire kaftan", quantity: 1, unitPriceKobo: 2_500_000 }],
      itemsValueKobo: 2_500_000,
      reason: "faulty",
      details: "The seam tore on first wear",
      refundTo: "wallet",
      returnShippingPaidBy: "merchant",
      merchantRespondBy: new Date(Date.now() + 86_400_000),
    });

    expect(await createDuePayouts()).toBe(0);
  });

  it("doesn't pay while payouts are off or the merchant is suspended", async () => {
    const { merchant } = await deliveredParcels(1);

    await setMarketplaceSettings({ payoutsEnabled: false });
    expect(await createDuePayouts()).toBe(0);

    await setMarketplaceSettings({ payoutsEnabled: true });
    merchant.status = "suspended";
    await merchant.save();
    expect(await createDuePayouts()).toBe(0);
  });

  it("retries with the same reference and never pays twice", async () => {
    await deliveredParcels(1);
    initiateMock.mockRejectedValueOnce(new PaystackRequestError("Insufficient balance"));

    await createDuePayouts();
    const failed = await Payout.findOne();
    expect(failed).toMatchObject({ status: "failed", failureReason: "Insufficient balance", attempts: 1 });

    // An hour later: Paystack has no record of the first attempt, so it's sent again with the same reference.
    await Payout.updateOne({ _id: failed!._id }, { $set: { lastAttemptAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    await retryPayouts();

    expect(verifyMock).toHaveBeenCalledWith(failed!.reference);
    expect(initiateMock).toHaveBeenCalledTimes(2);
    expect(initiateMock.mock.calls[1][0].reference).toBe(failed!.reference);
  });

  it("doesn't send again when an earlier attempt actually went through", async () => {
    await deliveredParcels(1);
    initiateMock.mockRejectedValueOnce(new Error("Couldn't reach Paystack to send the transfer."));
    await createDuePayouts();

    await Payout.updateOne({}, { $set: { lastAttemptAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    verifyMock.mockResolvedValue({ status: "success", transferCode: "TRF_earlier" });
    await retryPayouts();

    expect(initiateMock).toHaveBeenCalledTimes(1);
    expect((await Payout.findOne())?.status).toBe("paid");
  });

  it("explains how to fix a transfer that asks for an OTP", async () => {
    await deliveredParcels(1);
    initiateMock.mockResolvedValue({ status: "otp", transferCode: "TRF_otp" });

    await createDuePayouts();

    expect((await Payout.findOne())?.failureReason).toContain("Turn off OTP for transfers");
  });

  it("shows admins every payout and lets them retry", async () => {
    const admin = await createUser({ role: "admin" });
    await deliveredParcels(1);
    initiateMock.mockRejectedValueOnce(new PaystackRequestError("Insufficient balance"));
    await createDuePayouts();

    const list = await request(app).get("/api/admin/payouts?status=failed").set(auth(admin.token)).expect(200);
    expect(list.body[0]).toMatchObject({ amount: 47000, status: "failed", failureReason: "Insufficient balance" });

    initiateMock.mockResolvedValue({ status: "success", transferCode: "TRF_retry" });
    const retried = await request(app).post(`/api/admin/payouts/${list.body[0]._id}/retry`).set(auth(admin.token)).expect(200);
    expect(retried.body.payout.status).toBe("paid");
  });
});
