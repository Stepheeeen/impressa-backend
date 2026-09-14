import { Request, Response } from "express";
import type { IWalletTransaction } from "../models/WalletTransaction";
import { formatNaira, toNaira } from "../services/pricing";
import { checkIn, getRewardsStatus, scratchCard } from "../services/rewards";
import { getRewardSettings } from "../services/rewardSettings";
import { getWalletSummary } from "../services/wallet";

// Customers see what each entry was for, but never an admin's internal note.
const SOURCE_LABELS: Record<string, string> = {
  cashback: "Cashback",
  "check-in": "Daily check-in",
  "scratch-card": "Scratch card prize",
  adjustment: "Adjustment by Impressa",
  checkout: "Used at checkout",
  expiry: "Expired credit",
};

const transactionLabel = (transaction: Pick<IWalletTransaction, "kind" | "source">) =>
  transaction.kind === "release"
    ? "Returned from an unfinished checkout"
    : SOURCE_LABELS[transaction.source] ?? "Wallet update";

// GET /api/wallet
export const getWallet = async (req: Request, res: Response) => {
  const [settings, summary] = await Promise.all([getRewardSettings(), getWalletSummary(req.user!.id)]);

  res.json({
    enabled: settings.walletEnabled,
    balance: toNaira(summary.balanceKobo),
    creditExpiryDays: settings.creditExpiryDays,
    expiringSoon: summary.expiringSoon
      ? { amount: toNaira(summary.expiringSoon.amountKobo), expiresAt: summary.expiringSoon.expiresAt }
      : null,
    transactions: summary.transactions.map((transaction) => ({
      _id: transaction._id,
      kind: transaction.kind,
      label: transactionLabel(transaction),
      amount: toNaira(transaction.amountKobo),
      createdAt: transaction.createdAt,
    })),
  });
};

// GET /api/rewards
export const getRewards = async (req: Request, res: Response) => {
  const status = await getRewardsStatus(req.user!.id);

  res.json({
    eligible: status.eligible,
    budgetExhausted: status.budgetExhausted,
    checkIn: {
      enabled: status.checkIn.enabled,
      checkedInToday: status.checkIn.checkedInToday,
      streakDay: status.checkIn.streakDay,
      reward: toNaira(status.checkIn.rewardKobo),
      schedule: status.checkIn.scheduleKobo.map(toNaira),
    },
    scratchCards: {
      enabled: status.scratchCards.enabled,
      remainingToday: status.scratchCards.remainingToday,
      maxPrize: toNaira(status.scratchCards.maxPrizeKobo),
    },
  });
};

// POST /api/rewards/check-in
export const claimCheckIn = async (req: Request, res: Response) => {
  const result = await checkIn(req.user!.id);

  const message =
    result.amountKobo > 0
      ? `${formatNaira(result.amountKobo)} added to your wallet.`
      : result.rewardsPaused
        ? "You're checked in. Rewards are paused for the rest of this month."
        : "You're checked in.";

  res.status(201).json({
    streakDay: result.streakDay,
    amount: toNaira(result.amountKobo),
    rewardsPaused: result.rewardsPaused,
    message,
  });
};

// POST /api/rewards/scratch-cards
export const claimScratchCard = async (req: Request, res: Response) => {
  const result = await scratchCard(req.user!.id);

  res.status(201).json({
    amount: toNaira(result.amountKobo),
    remainingToday: result.remainingToday,
    message:
      result.amountKobo > 0
        ? `You won ${formatNaira(result.amountKobo)}! It's in your wallet.`
        : "No prize this time. Try again tomorrow.",
  });
};
