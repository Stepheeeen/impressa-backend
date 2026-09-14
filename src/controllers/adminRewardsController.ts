import crypto from "crypto";
import { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import Coupon, { COUPON_TYPES, ICoupon } from "../models/Coupon";
import CouponRedemption from "../models/CouponRedemption";
import RewardSettings, { IRewardSettings, WALLET_USAGE_MODES } from "../models/RewardSettings";
import User from "../models/User";
import WalletLot from "../models/WalletLot";
import WalletTransaction from "../models/WalletTransaction";
import { toKobo, toNaira } from "../services/pricing";
import { sumCreditsKobo } from "../services/rewards";
import { getRewardSettings } from "../services/rewardSettings";
import { daysFromNow, startOfLagosMonth } from "../services/time";
import {
  creditWallet,
  findWalletMismatches,
  getWalletSummary,
  InsufficientCreditError,
  spendFromWallet,
} from "../services/wallet";
import { emptyToNull, optionalDate } from "../validation/fields";

const nairaAmount = (label: string) =>
  z.coerce.number({ error: `${label} must be a number.` }).min(0, `${label} can't be negative.`);

// ----- Reward settings (amounts are in naira here and stored in kobo) -----

const SettingsSchema = z.object({
  walletEnabled: z.boolean(),
  couponsEnabled: z.boolean(),
  cashbackEnabled: z.boolean(),
  checkInEnabled: z.boolean(),
  scratchCardsEnabled: z.boolean(),
  rewardsRequirePurchase: z.boolean(),
  creditExpiryDays: z.coerce
    .number()
    .int("Use a whole number of days.")
    .min(1, "Credit must last at least 1 day.")
    .max(3650, "Credit can last at most 10 years."),
  walletUsageMode: z.enum(WALLET_USAGE_MODES, { error: "Choose how much of an order credit can pay for." }),
  walletUsagePercent: z.coerce.number().int().min(1, "Use a percentage from 1 to 100.").max(100, "Use a percentage from 1 to 100."),
  cashbackPercent: z.coerce.number().min(0, "Cashback can't be negative.").max(100, "Cashback can't be more than 100%."),
  cashbackMax: nairaAmount("Maximum cashback"),
  checkInRewards: z
    .array(nairaAmount("Check-in reward"))
    .min(1, "Add at least one check-in reward.")
    .max(14, "Use at most 14 check-in days."),
  scratchPrizes: z
    .array(
      z.object({
        amount: nairaAmount("Prize"),
        weight: z.coerce.number().int("Chances must be whole numbers.").min(0, "Chances can't be negative."),
      })
    )
    .min(1, "Add at least one scratch card prize.")
    .refine((prizes) => prizes.some((prize) => prize.weight > 0), "At least one prize needs a chance above zero."),
  scratchCardsPerDay: z.coerce.number().int().min(1, "Allow at least 1 card a day.").max(10, "Allow at most 10 cards a day."),
  gamesMonthlyBudget: nairaAmount("Monthly budget"),
});

function toSettingsResponse(settings: IRewardSettings) {
  return {
    walletEnabled: settings.walletEnabled,
    couponsEnabled: settings.couponsEnabled,
    cashbackEnabled: settings.cashbackEnabled,
    checkInEnabled: settings.checkInEnabled,
    scratchCardsEnabled: settings.scratchCardsEnabled,
    rewardsRequirePurchase: settings.rewardsRequirePurchase,
    creditExpiryDays: settings.creditExpiryDays,
    walletUsageMode: settings.walletUsageMode,
    walletUsagePercent: settings.walletUsagePercent,
    cashbackPercent: settings.cashbackPercent,
    cashbackMax: toNaira(settings.cashbackMaxKobo),
    checkInRewards: settings.checkInRewardsKobo.map(toNaira),
    scratchPrizes: settings.scratchPrizes.map((prize) => ({ amount: toNaira(prize.amountKobo), weight: prize.weight })),
    scratchCardsPerDay: settings.scratchCardsPerDay,
    gamesMonthlyBudget: toNaira(settings.gamesMonthlyBudgetKobo),
  };
}

// GET /api/admin/rewards/settings
export const getAdminRewardSettings = async (_req: Request, res: Response) => {
  res.json(toSettingsResponse(await getRewardSettings()));
};

// PUT /api/admin/rewards/settings
export const updateRewardSettings = async (req: Request, res: Response) => {
  const input = SettingsSchema.parse(req.body ?? {});
  await getRewardSettings(); // creates the document the first time

  const settings = await RewardSettings.findOneAndUpdate(
    { key: "rewards" },
    {
      $set: {
        walletEnabled: input.walletEnabled,
        couponsEnabled: input.couponsEnabled,
        cashbackEnabled: input.cashbackEnabled,
        checkInEnabled: input.checkInEnabled,
        scratchCardsEnabled: input.scratchCardsEnabled,
        rewardsRequirePurchase: input.rewardsRequirePurchase,
        creditExpiryDays: input.creditExpiryDays,
        walletUsageMode: input.walletUsageMode,
        walletUsagePercent: input.walletUsagePercent,
        cashbackPercent: input.cashbackPercent,
        cashbackMaxKobo: toKobo(input.cashbackMax),
        checkInRewardsKobo: input.checkInRewards.map(toKobo),
        scratchPrizes: input.scratchPrizes.map((prize) => ({ amountKobo: toKobo(prize.amount), weight: prize.weight })),
        scratchCardsPerDay: input.scratchCardsPerDay,
        gamesMonthlyBudgetKobo: toKobo(input.gamesMonthlyBudget),
      },
    },
    { new: true }
  );

  res.json({ message: "Reward settings saved", settings: toSettingsResponse(settings!) });
};

// GET /api/admin/rewards/summary
export const getRewardsSummary = async (_req: Request, res: Response) => {
  const now = new Date();
  const monthStart = startOfLagosMonth(now);

  const [settings, gamesKobo, cashbackKobo, [credit]] = await Promise.all([
    getRewardSettings(),
    sumCreditsKobo(["check-in", "scratch-card"], monthStart),
    sumCreditsKobo(["cashback"], monthStart),
    WalletLot.aggregate<{ outstanding: number; expiringSoon: number }>([
      { $match: { remainingKobo: { $gt: 0 }, expiresAt: { $gt: now } } },
      {
        $group: {
          _id: null,
          outstanding: { $sum: "$remainingKobo" },
          expiringSoon: { $sum: { $cond: [{ $lte: ["$expiresAt", daysFromNow(30, now)] }, "$remainingKobo", 0] } },
        },
      },
    ]),
  ]);

  res.json({
    gamesSpentThisMonth: toNaira(gamesKobo),
    gamesMonthlyBudget: toNaira(settings.gamesMonthlyBudgetKobo),
    cashbackThisMonth: toNaira(cashbackKobo),
    outstandingCredit: toNaira(credit?.outstanding ?? 0),
    expiringNext30Days: toNaira(credit?.expiringSoon ?? 0),
  });
};

// ----- Coupons -----

const optionalNumber = (schema: z.ZodType<number>) => z.preprocess(emptyToNull, schema.nullable());

const CouponSchema = z
  .object({
    code: z
      .string({ error: "Add a coupon code." })
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{3,20}$/, "Codes are 3–20 letters, numbers, dashes or underscores."),
    description: z.string().trim().max(120, "Keep the description under 120 characters.").default(""),
    type: z.enum(COUPON_TYPES, { error: "Choose percent off or amount off." }),
    percentOff: optionalNumber(
      z.coerce.number({ error: "Percent off must be a number." }).min(1, "Percent off must be 1–100.").max(100, "Percent off must be 1–100.")
    ),
    amountOff: optionalNumber(z.coerce.number({ error: "Amount off must be a number." }).positive("Amount off must be above zero.")),
    maxDiscount: optionalNumber(z.coerce.number({ error: "Maximum discount must be a number." }).positive("Maximum discount must be above zero.")),
    minSubtotal: z.preprocess(
      (value) => (value === "" || value == null ? 0 : value),
      z.coerce.number({ error: "Minimum spend must be a number." }).min(0, "Minimum spend can't be negative.")
    ),
    startsAt: optionalDate,
    endsAt: optionalDate,
    usageLimit: optionalNumber(z.coerce.number().int("Usage limit must be a whole number.").positive("Usage limit must be at least 1.")),
    perCustomerLimit: z.coerce.number().int().min(1, "Each customer must be able to use it at least once.").default(1),
    active: z.boolean().default(true),
  })
  .superRefine((coupon, ctx) => {
    if (coupon.type === "percent" && coupon.percentOff === null) {
      ctx.addIssue({ code: "custom", path: ["percentOff"], message: "Enter the percent off." });
    }
    if (coupon.type === "fixed" && coupon.amountOff === null) {
      ctx.addIssue({ code: "custom", path: ["amountOff"], message: "Enter the amount off." });
    }
    if (coupon.startsAt && coupon.endsAt && coupon.endsAt <= coupon.startsAt) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end date must be after the start date." });
    }
  });

type CouponInput = z.infer<typeof CouponSchema>;

const toCouponFields = (input: CouponInput) => ({
  code: input.code,
  description: input.description,
  type: input.type,
  percentOff: input.type === "percent" ? input.percentOff : null,
  amountOffKobo: input.type === "fixed" && input.amountOff !== null ? toKobo(input.amountOff) : null,
  maxDiscountKobo: input.maxDiscount !== null ? toKobo(input.maxDiscount) : null,
  minSubtotalKobo: toKobo(input.minSubtotal),
  startsAt: input.startsAt,
  endsAt: input.endsAt,
  usageLimit: input.usageLimit,
  perCustomerLimit: input.perCustomerLimit,
  active: input.active,
});

const toCouponResponse = (coupon: ICoupon) => ({
  _id: coupon._id,
  code: coupon.code,
  description: coupon.description ?? "",
  type: coupon.type,
  percentOff: coupon.percentOff ?? null,
  amountOff: coupon.amountOffKobo != null ? toNaira(coupon.amountOffKobo) : null,
  maxDiscount: coupon.maxDiscountKobo != null ? toNaira(coupon.maxDiscountKobo) : null,
  minSubtotal: toNaira(coupon.minSubtotalKobo),
  startsAt: coupon.startsAt ?? null,
  endsAt: coupon.endsAt ?? null,
  usageLimit: coupon.usageLimit ?? null,
  perCustomerLimit: coupon.perCustomerLimit,
  timesUsed: coupon.timesUsed,
  active: coupon.active,
});

const duplicateCode = (err: any) =>
  err?.code === 11000 ? new HttpError(409, "A coupon with that code already exists.") : err;

// GET /api/admin/coupons
export const listCoupons = async (_req: Request, res: Response) => {
  const coupons = await Coupon.find().sort({ createdAt: -1 });
  res.json(coupons.map(toCouponResponse));
};

// POST /api/admin/coupons
export const createCoupon = async (req: Request, res: Response) => {
  const input = CouponSchema.parse(req.body ?? {});
  try {
    const coupon = await Coupon.create(toCouponFields(input));
    res.status(201).json({ message: "Coupon created", coupon: toCouponResponse(coupon) });
  } catch (err) {
    throw duplicateCode(err);
  }
};

// PUT /api/admin/coupons/:id
export const updateCoupon = async (req: Request, res: Response) => {
  const input = CouponSchema.parse(req.body ?? {});
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, toCouponFields(input), { new: true });
    if (!coupon) throw new HttpError(404, "Coupon not found");
    res.json({ message: "Coupon updated", coupon: toCouponResponse(coupon) });
  } catch (err) {
    throw duplicateCode(err);
  }
};

// DELETE /api/admin/coupons/:id
export const deleteCoupon = async (req: Request, res: Response) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) throw new HttpError(404, "Coupon not found");
  if (coupon.timesUsed > 0 || (await CouponRedemption.exists({ coupon: coupon._id }))) {
    throw new HttpError(409, "This coupon has been used, so it can't be deleted. Switch it off instead.");
  }
  await coupon.deleteOne();
  res.json({ message: "Coupon deleted" });
};

// ----- Customer wallets -----

const WalletLookupSchema = z.object({
  email: z.string({ error: "Enter the customer's email." }).trim().min(3, "Enter the customer's email."),
});

// GET /api/admin/wallets?email=
export const findCustomerWallet = async (req: Request, res: Response) => {
  const { email } = WalletLookupSchema.parse(req.query);
  const customer = await User.findOne({ email }).collation({ locale: "en", strength: 2 });
  if (!customer) throw new HttpError(404, "No customer has that email.");

  const summary = await getWalletSummary(customer.id);
  await WalletTransaction.populate(summary.transactions, { path: "actor", select: "email" });

  res.json({
    customer: { _id: customer._id, username: customer.username, email: customer.email },
    balance: toNaira(summary.balanceKobo),
    expiringSoon: summary.expiringSoon
      ? { amount: toNaira(summary.expiringSoon.amountKobo), expiresAt: summary.expiringSoon.expiresAt }
      : null,
    transactions: summary.transactions.map((transaction: any) => ({
      _id: transaction._id,
      kind: transaction.kind,
      source: transaction.source,
      amount: toNaira(transaction.amountKobo),
      reference: transaction.reference ?? null,
      note: transaction.note ?? null,
      actor: transaction.actor?.email ?? null,
      createdAt: transaction.createdAt,
    })),
  });
};

const AdjustmentSchema = z.object({
  amount: z.coerce
    .number({ error: "Enter an amount." })
    .refine((value) => value !== 0, "Enter an amount other than zero.")
    .refine((value) => Math.abs(value) <= 1_000_000, "Adjustments are limited to ₦1,000,000 at a time."),
  reason: z
    .string({ error: "Give a reason of at least 5 characters." })
    .trim()
    .min(5, "Give a reason of at least 5 characters.")
    .max(200, "Keep the reason under 200 characters."),
  // Sent by the admin panel so a double-click doesn't adjust twice.
  requestId: z
    .string()
    .regex(/^[0-9a-f-]{36}$/i)
    .optional(),
});

// POST /api/admin/wallets/:userId/adjustments — positive amounts add credit, negative amounts remove it.
export const adjustWallet = async (req: Request, res: Response) => {
  const { amount, reason, requestId } = AdjustmentSchema.parse(req.body ?? {});
  const customer = await User.findById(req.params.userId);
  if (!customer) throw new HttpError(404, "Customer not found.");

  const adjustment = {
    userId: customer.id,
    amountKobo: toKobo(Math.abs(amount)),
    idempotencyKey: `adjustment:${requestId ?? crypto.randomUUID()}`,
    actorId: req.user!.id,
    note: reason,
  };

  if (amount > 0) {
    const settings = await getRewardSettings();
    await creditWallet({ ...adjustment, source: "adjustment", expiryDays: settings.creditExpiryDays });
  } else {
    try {
      await spendFromWallet({ ...adjustment, source: "adjustment" });
    } catch (err) {
      if (err instanceof InsufficientCreditError) throw new HttpError(400, "The customer doesn't have that much credit.");
      throw err;
    }
  }

  const { balanceKobo } = await getWalletSummary(customer.id);
  res.status(201).json({ message: amount > 0 ? "Credit added" : "Credit removed", balance: toNaira(balanceKobo) });
};

// GET /api/admin/wallets/reconciliation
export const getReconciliation = async (_req: Request, res: Response) => {
  const mismatches = await findWalletMismatches();
  res.json({
    checkedAt: new Date(),
    mismatches: mismatches.map((mismatch) => ({
      userId: mismatch.userId,
      ledger: toNaira(mismatch.ledgerKobo),
      lots: toNaira(mismatch.lotsKobo),
    })),
  });
};
