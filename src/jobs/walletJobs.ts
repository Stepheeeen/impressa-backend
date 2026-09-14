import * as Sentry from "@sentry/node";
import { Types } from "mongoose";
import WalletLot from "../models/WalletLot";
import { formatNaira } from "../services/pricing";
import { notifyUser } from "../services/push";
import { daysFromNow } from "../services/time";
import { expireLots, findWalletMismatches, settleExpiredHolds } from "../services/wallet";

const RUN_EVERY_MS = 15 * 60 * 1000;
const HOURLY = 4; // runs

// Notifies customers a week before credit expires, once per credit.
export async function sendExpiryReminders(now = new Date()) {
  const lots = await WalletLot.find({
    remainingKobo: { $gt: 0 },
    expiresAt: { $gt: now, $lte: daysFromNow(7, now) },
    reminderSentAt: null,
  })
    .sort({ expiresAt: 1 })
    .lean();

  const byCustomer = new Map<string, { amountKobo: number; expiresAt: Date; lotIds: Types.ObjectId[] }>();
  for (const lot of lots) {
    const entry = byCustomer.get(String(lot.user)) ?? { amountKobo: 0, expiresAt: lot.expiresAt, lotIds: [] };
    entry.amountKobo += lot.remainingKobo;
    entry.lotIds.push(lot._id as Types.ObjectId);
    byCustomer.set(String(lot.user), entry);
  }

  for (const [userId, entry] of byCustomer) {
    const date = entry.expiresAt.toLocaleDateString("en-NG", { day: "numeric", month: "short", timeZone: "Africa/Lagos" });
    notifyUser({
      userId,
      title: "Your Impressa credit is expiring",
      body: `${formatNaira(entry.amountKobo)} of your wallet credit expires on ${date}. Use it on your next order.`,
      data: { type: "wallet" },
    });
    await WalletLot.updateMany({ _id: { $in: entry.lotIds } }, { $set: { reminderSentAt: now } });
  }
  return byCustomer.size;
}

export async function runWalletJobs({ hourly }: { hourly: boolean }) {
  await expireLots();
  await settleExpiredHolds();
  if (!hourly) return;

  await sendExpiryReminders();
  const mismatches = await findWalletMismatches();
  if (mismatches.length > 0) {
    const message = `Wallet reconciliation found ${mismatches.length} mismatched wallet(s)`;
    console.error(message, mismatches);
    Sentry.captureMessage(message, "error");
  }
}

// Runs inside the API process. Every job is safe to run twice, so overlapping instances during a deploy are fine.
export function scheduleWalletJobs() {
  let runs = 0;
  const tick = () => {
    const hourly = runs % HOURLY === 0;
    runs += 1;
    runWalletJobs({ hourly }).catch((err) => {
      console.error("Wallet jobs failed:", err);
      Sentry.captureException(err);
    });
  };

  tick();
  return setInterval(tick, RUN_EVERY_MS);
}
