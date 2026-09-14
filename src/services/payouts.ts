import * as Sentry from "@sentry/node";
import mongoose from "mongoose";
import Fulfilment from "../models/Fulfilment";
import Merchant from "../models/Merchant";
import Payout from "../models/Payout";
import ReturnRequest from "../models/ReturnRequest";
import { withTransaction } from "./db";
import { getMarketplaceSettings } from "./marketplaceSettings";
import { initiateTransfer, PaystackRequestError, verifyTransfer } from "./paystack";
import { formatNaira } from "./pricing";
import { notifyUser } from "./push";
import { daysFromNow, hoursFromNow } from "./time";

const RETRY_AFTER_HOURS = 1;
const MAX_ATTEMPTS = 5;
// A transfer still "processing" after this long is checked with Paystack in case the webhook was missed.
const CHECK_PROCESSING_AFTER_HOURS = 6;

const OTP_MESSAGE = "Paystack is asking for an OTP. Turn off OTP for transfers in the Paystack dashboard, then retry.";
const FAILED_STATUSES = ["failed", "reversed", "abandoned", "rejected", "blocked"];

class ClaimConflict extends Error {}

// Records a transfer's outcome, from the initiate response, a verify call or a webhook. Safe to repeat.
export async function applyTransferStatus(reference: string, status: string, transferCode?: string | null, reason?: string) {
  const payout = await Payout.findOne({ reference });
  if (!payout) return;

  if (status === "success") {
    const paidAt = new Date();
    const updated = await Payout.findOneAndUpdate(
      { _id: payout._id, status: { $ne: "paid" } },
      { $set: { status: "paid", paidAt, transferCode: transferCode ?? payout.transferCode, failureReason: "" } }
    );
    if (!updated) return;

    await Fulfilment.updateMany({ _id: { $in: payout.fulfilments } }, { $set: { "payout.status": "paid", "payout.paidAt": paidAt } });
    const merchant = await Merchant.findById(payout.merchant).lean();
    if (merchant) {
      notifyUser({
        userId: String(merchant.user),
        title: "Payout sent",
        body: `${formatNaira(payout.amountKobo)} is on its way to ${merchant.bank.bankName} ••••${merchant.bank.accountNumberLast4}.`,
        data: { type: "merchant-payout", payoutId: String(payout._id) },
      });
    }
    return;
  }

  if (status === "otp" || FAILED_STATUSES.includes(status)) {
    const failureReason = status === "otp" ? OTP_MESSAGE : reason || `Transfer ${status}`;
    // A reversal can arrive after a success, so it applies even to paid payouts.
    const filter = status === "reversed" ? { _id: payout._id } : { _id: payout._id, status: { $ne: "paid" } };
    const updated = await Payout.updateOne(filter, { $set: { status: "failed", failureReason, transferCode: transferCode ?? payout.transferCode } });
    if (updated.modifiedCount === 1) {
      if (status === "reversed") {
        await Fulfilment.updateMany({ _id: { $in: payout.fulfilments } }, { $set: { "payout.status": "processing", "payout.paidAt": null } });
      }
      const message = `Payout ${payout.reference} ${status}: ${failureReason}`;
      console.error(message);
      Sentry.captureMessage(message, "error");
    }
    return;
  }

  // pending, processing, received, queued: Paystack is still working on it.
  await Payout.updateOne({ _id: payout._id, status: { $ne: "paid" } }, { $set: { status: "processing", transferCode: transferCode ?? payout.transferCode } });
}

// Sends (or re-sends) a payout. The same reference is used every time, and a retry first asks Paystack
// whether an earlier attempt went through, so a merchant is never paid twice.
export async function sendPayout(payoutId: string) {
  const payout = await Payout.findOneAndUpdate(
    { _id: payoutId, status: { $in: ["processing", "failed"] } },
    { $inc: { attempts: 1 }, $set: { lastAttemptAt: new Date() } },
    { new: true }
  );
  if (!payout) return;

  if (payout.amountKobo === 0) {
    // Everything in it was refunded, so there's nothing to send.
    await applyTransferStatus(payout.reference, "success");
    return;
  }

  try {
    const earlier = payout.attempts > 1 ? await verifyTransfer(payout.reference) : null;
    const result =
      earlier ??
      (await initiateTransfer({
        amountKobo: payout.amountKobo,
        recipientCode: payout.recipientCode,
        reference: payout.reference,
        reason: `Impressa payout for ${payout.fulfilments.length} order${payout.fulfilments.length === 1 ? "" : "s"}`,
      }));
    await applyTransferStatus(payout.reference, result.status, result.transferCode, result.reason);
  } catch (err) {
    const failureReason = err instanceof PaystackRequestError ? err.message : "Couldn't reach Paystack. It will be retried.";
    await Payout.updateOne({ _id: payout._id, status: { $ne: "paid" } }, { $set: { status: "failed", failureReason } });
    console.error(`Payout ${payout.reference} attempt ${payout.attempts} failed:`, err);
    Sentry.captureException(err);
  }
}

// Pays each approved merchant for parcels delivered more than the returns window ago with no open return,
// in one transfer per merchant.
export async function createDuePayouts(now = new Date()) {
  const settings = await getMarketplaceSettings();
  if (!settings.payoutsEnabled) return 0;

  const due = await Fulfilment.find({
    merchant: { $ne: null },
    status: "delivered",
    deliveredAt: { $lte: daysFromNow(-settings.returnWindowDays, now) },
    "payout.status": "pending",
  })
    .select("_id merchant payoutKobo")
    .lean();
  if (due.length === 0) return 0;

  const withOpenReturns = new Set(
    (await ReturnRequest.find({ fulfilment: { $in: due.map((f) => f._id) }, open: true }).select("fulfilment").lean()).map((r) =>
      String(r.fulfilment)
    )
  );

  const byMerchant = new Map<string, typeof due>();
  for (const fulfilment of due) {
    if (withOpenReturns.has(String(fulfilment._id))) continue;
    const list = byMerchant.get(String(fulfilment.merchant)) ?? [];
    list.push(fulfilment);
    byMerchant.set(String(fulfilment.merchant), list);
  }

  // Suspended merchants' payouts wait until they're reinstated.
  const merchants = await Merchant.find({ _id: { $in: [...byMerchant.keys()] }, status: "approved" }).lean();

  let created = 0;
  for (const merchant of merchants) {
    const fulfilments = byMerchant.get(String(merchant._id))!;
    const ids = fulfilments.map((f) => f._id);
    const payoutId = new mongoose.Types.ObjectId();

    const claimed = await withTransaction(async (session) => {
      const result = await Fulfilment.updateMany(
        { _id: { $in: ids }, "payout.status": "pending" },
        { $set: { "payout.status": "processing", "payout.payoutId": payoutId } },
        { session }
      );
      // Another run already claimed some of these parcels.
      if (result.modifiedCount !== ids.length) throw new ClaimConflict();
      await Payout.create(
        [
          {
            _id: payoutId,
            merchant: merchant._id,
            fulfilments: ids,
            amountKobo: fulfilments.reduce((sum, f) => sum + f.payoutKobo, 0),
            reference: `payout_${payoutId}`,
            recipientCode: merchant.bank.recipientCode,
          },
        ],
        { session }
      );
      return true;
    }).catch((err) => {
      if (err instanceof ClaimConflict) return false;
      throw err;
    });

    if (!claimed) continue;
    await sendPayout(String(payoutId));
    created++;
  }
  return created;
}

// Retries failed payouts and checks on transfers that have been processing for a long time.
export async function retryPayouts(now = new Date()) {
  const [failed, stuck] = await Promise.all([
    Payout.find({ status: "failed", attempts: { $lt: MAX_ATTEMPTS }, lastAttemptAt: { $lte: hoursFromNow(-RETRY_AFTER_HOURS, now) } })
      .select("_id")
      .lean(),
    Payout.find({ status: "processing", lastAttemptAt: { $lte: hoursFromNow(-CHECK_PROCESSING_AFTER_HOURS, now) } })
      .select("reference")
      .lean(),
  ]);

  for (const payout of failed) await sendPayout(String(payout._id));
  for (const payout of stuck) {
    const result = await verifyTransfer(payout.reference).catch(() => null);
    if (result) await applyTransferStatus(payout.reference, result.status, result.transferCode, result.reason);
  }
  return failed.length + stuck.length;
}
