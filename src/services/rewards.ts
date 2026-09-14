import crypto from "crypto";
import mongoose from "mongoose";
import { HttpError } from "../middleware/errorHandler";
import CheckIn from "../models/CheckIn";
import Order from "../models/Order";
import type { IRewardSettings } from "../models/RewardSettings";
import ScratchCard from "../models/ScratchCard";
import WalletTransaction from "../models/WalletTransaction";
import { formatNaira } from "./pricing";
import { notifyUser, orderNumber } from "./push";
import { getRewardSettings } from "./rewardSettings";
import { lagosDay, previousLagosDay, startOfLagosMonth } from "./time";
import { creditWallet } from "./wallet";

const GAME_SOURCES = ["check-in", "scratch-card"];

export async function sumCreditsKobo(sources: string[], since: Date) {
  const [row] = await WalletTransaction.aggregate<{ total: number }>([
    { $match: { kind: "credit", source: { $in: sources }, createdAt: { $gte: since } } },
    { $group: { _id: null, total: { $sum: "$amountKobo" } } },
  ]);
  return row?.total ?? 0;
}

export const gamesSpentThisMonthKobo = () => sumCreditsKobo(GAME_SOURCES, startOfLagosMonth());

// A reward is paid in full or not at all once the month's games budget can't cover it.
// Simultaneous claims at the very end of the budget can go over it by at most one reward.
async function affordableRewardKobo(amountKobo: number, settings: IRewardSettings) {
  if (amountKobo <= 0) return 0;
  const remainingKobo = settings.gamesMonthlyBudgetKobo - (await gamesSpentThisMonthKobo());
  return remainingKobo >= amountKobo ? amountKobo : 0;
}

async function hasPaidOrder(userId: string) {
  return Boolean(await Order.exists({ user: userId, status: { $in: ["paid", "shipped", "delivered"] } }));
}

async function ensureEligible(userId: string, settings: IRewardSettings) {
  if (settings.rewardsRequirePurchase && !(await hasPaidOrder(userId))) {
    throw new HttpError(403, "Place your first order to unlock daily rewards.");
  }
}

function nextStreakDay(last: { day: string; streakDay: number } | null, schedule: number[]) {
  if (last?.day === previousLagosDay()) return (last.streakDay % schedule.length) + 1;
  return 1;
}

export async function getRewardsStatus(userId: string) {
  const settings = await getRewardSettings();
  const today = lagosDay();
  const [eligible, lastCheckIn, cardsToday, spentKobo] = await Promise.all([
    settings.rewardsRequirePurchase ? hasPaidOrder(userId) : Promise.resolve(true),
    CheckIn.findOne({ user: userId }).sort({ day: -1 }).lean(),
    ScratchCard.countDocuments({ user: userId, day: today }),
    gamesSpentThisMonthKobo(),
  ]);

  const schedule = settings.checkInRewardsKobo;
  const checkedInToday = lastCheckIn?.day === today;
  const streakDay = checkedInToday ? lastCheckIn.streakDay : nextStreakDay(lastCheckIn, schedule);

  return {
    eligible,
    budgetExhausted: spentKobo >= settings.gamesMonthlyBudgetKobo,
    checkIn: {
      enabled: settings.checkInEnabled,
      checkedInToday,
      streakDay,
      rewardKobo: schedule[streakDay - 1] ?? 0,
      scheduleKobo: schedule,
    },
    scratchCards: {
      enabled: settings.scratchCardsEnabled,
      remainingToday: Math.max(0, settings.scratchCardsPerDay - cardsToday),
      maxPrizeKobo: Math.max(0, ...settings.scratchPrizes.map((prize) => prize.amountKobo)),
    },
  };
}

export async function checkIn(userId: string) {
  const settings = await getRewardSettings();
  if (!settings.checkInEnabled) throw new HttpError(403, "Daily check-in is switched off right now.");
  await ensureEligible(userId, settings);

  const alreadyCheckedIn = new HttpError(409, "You've already checked in today. Come back tomorrow.");
  const today = lagosDay();
  const last = await CheckIn.findOne({ user: userId }).sort({ day: -1 }).lean();
  if (last?.day === today) throw alreadyCheckedIn;

  const schedule = settings.checkInRewardsKobo;
  const streakDay = nextStreakDay(last, schedule);
  const scheduledKobo = schedule[streakDay - 1] ?? 0;
  const amountKobo = await affordableRewardKobo(scheduledKobo, settings);

  try {
    await mongoose.connection.transaction(async (session) => {
      const [record] = await CheckIn.create([{ user: userId, day: today, streakDay, amountKobo }], { session });
      if (amountKobo > 0) {
        await creditWallet(
          {
            userId,
            amountKobo,
            source: "check-in",
            expiryDays: settings.creditExpiryDays,
            idempotencyKey: `check-in:${userId}:${today}`,
            reference: String(record._id),
          },
          session
        );
      }
    });
  } catch (err: any) {
    if (err?.code === 11000) throw alreadyCheckedIn;
    throw err;
  }

  return { streakDay, amountKobo, rewardsPaused: amountKobo === 0 && scheduledKobo > 0 };
}

// The prize is decided here, before the card is revealed; the app only animates the result.
function pickPrizeKobo(prizes: { amountKobo: number; weight: number }[]) {
  const totalWeight = prizes.reduce((sum, prize) => sum + Math.max(0, prize.weight), 0);
  if (totalWeight <= 0) return 0;

  let roll = crypto.randomInt(totalWeight);
  for (const prize of prizes) {
    roll -= Math.max(0, prize.weight);
    if (roll < 0) return prize.amountKobo;
  }
  return 0;
}

export async function scratchCard(userId: string) {
  const settings = await getRewardSettings();
  if (!settings.scratchCardsEnabled) throw new HttpError(403, "Scratch cards are switched off right now.");
  await ensureEligible(userId, settings);

  const usedUp = new HttpError(409, "You've used today's scratch cards. Come back tomorrow.");
  const today = lagosDay();
  const used = await ScratchCard.countDocuments({ user: userId, day: today });
  if (used >= settings.scratchCardsPerDay) throw usedUp;

  const amountKobo = await affordableRewardKobo(pickPrizeKobo(settings.scratchPrizes), settings);

  try {
    await mongoose.connection.transaction(async (session) => {
      const [card] = await ScratchCard.create([{ user: userId, day: today, slot: used + 1, amountKobo }], { session });
      if (amountKobo > 0) {
        await creditWallet(
          {
            userId,
            amountKobo,
            source: "scratch-card",
            expiryDays: settings.creditExpiryDays,
            idempotencyKey: `scratch-card:${card._id}`,
            reference: String(card._id),
          },
          session
        );
      }
    });
  } catch (err: any) {
    if (err?.code === 11000) throw usedUp;
    throw err;
  }

  return { amountKobo, remainingToday: settings.scratchCardsPerDay - used - 1 };
}

// Credits cashback on the part of a delivered order that was paid by card. Safe to call more than once.
export async function awardCashback(orderId: string) {
  const [order, settings] = await Promise.all([Order.findById(orderId).lean(), getRewardSettings()]);
  // Orders from before the wallet checkout don't record their card payment, so they don't earn cashback.
  if (!order?.pricing || order.status !== "delivered" || !settings.cashbackEnabled) return 0;

  const amountKobo = Math.min(
    Math.floor((order.pricing.cardPaidKobo * settings.cashbackPercent) / 100),
    settings.cashbackMaxKobo
  );
  if (amountKobo <= 0) return 0;

  const credited = await creditWallet({
    userId: String(order.user),
    amountKobo,
    source: "cashback",
    expiryDays: settings.creditExpiryDays,
    idempotencyKey: `cashback:${order._id}`,
    reference: String(order._id),
  });
  if (!credited) return 0;

  await Order.updateOne({ _id: order._id }, { $set: { cashbackKobo: amountKobo } });
  notifyUser({
    userId: String(order.user),
    title: "You earned cashback",
    body: `${formatNaira(amountKobo)} cashback from order #${orderNumber(String(order._id))} is in your wallet.`,
    data: { type: "wallet" },
  });
  return amountKobo;
}
