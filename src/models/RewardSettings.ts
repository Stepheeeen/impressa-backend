import mongoose, { Schema, Document } from "mongoose";

export const WALLET_USAGE_MODES = ["whole-order", "items-only", "percent-of-items"] as const;
export type WalletUsageMode = (typeof WALLET_USAGE_MODES)[number];

export interface IRewardSettings extends Document {
  key: "rewards";
  walletEnabled: boolean;
  couponsEnabled: boolean;
  cashbackEnabled: boolean;
  checkInEnabled: boolean;
  scratchCardsEnabled: boolean;
  // Daily games only unlock after a customer's first paid order, so new accounts can't farm credit.
  rewardsRequirePurchase: boolean;
  creditExpiryDays: number;
  walletUsageMode: WalletUsageMode;
  walletUsagePercent: number;
  cashbackPercent: number;
  cashbackMaxKobo: number;
  checkInRewardsKobo: number[];
  scratchPrizes: { amountKobo: number; weight: number }[];
  scratchCardsPerDay: number;
  gamesMonthlyBudgetKobo: number;
}

// A single document holds every reward setting; the admin panel edits it. Defaults are the suggested starting values.
const RewardSettingsSchema = new Schema(
  {
    key: { type: String, default: "rewards", unique: true },
    walletEnabled: { type: Boolean, default: true },
    couponsEnabled: { type: Boolean, default: true },
    cashbackEnabled: { type: Boolean, default: true },
    checkInEnabled: { type: Boolean, default: true },
    scratchCardsEnabled: { type: Boolean, default: true },
    rewardsRequirePurchase: { type: Boolean, default: true },
    creditExpiryDays: { type: Number, default: 90 },
    walletUsageMode: { type: String, enum: WALLET_USAGE_MODES, default: "whole-order" },
    walletUsagePercent: { type: Number, default: 50 },
    cashbackPercent: { type: Number, default: 2 },
    cashbackMaxKobo: { type: Number, default: 200_000 },
    checkInRewardsKobo: { type: [Number], default: [2000, 2000, 3000, 3000, 5000, 5000, 10000] },
    scratchPrizes: {
      type: [{ _id: false, amountKobo: { type: Number, required: true }, weight: { type: Number, required: true } }],
      default: [
        { amountKobo: 0, weight: 40 },
        { amountKobo: 2000, weight: 30 },
        { amountKobo: 5000, weight: 20 },
        { amountKobo: 10000, weight: 8 },
        { amountKobo: 50000, weight: 2 },
      ],
    },
    scratchCardsPerDay: { type: Number, default: 1 },
    gamesMonthlyBudgetKobo: { type: Number, default: 20_000_000 },
  },
  { timestamps: true }
);

export default mongoose.model<IRewardSettings>("RewardSettings", RewardSettingsSchema);
