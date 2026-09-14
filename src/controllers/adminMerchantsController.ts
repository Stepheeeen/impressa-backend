import { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import Fulfilment from "../models/Fulfilment";
import MarketplaceSettings from "../models/MarketplaceSettings";
import Merchant, { IMerchant, MERCHANT_STATUSES, MerchantStatus } from "../models/Merchant";
import ProductTemplate from "../models/ProductTemplate";
import { idDocumentUrl } from "../services/cloudinary";
import { toAdminFulfilment, updateFulfilmentTracking } from "../services/fulfilments";
import { getMarketplaceSettings } from "../services/marketplaceSettings";
import { toNaira } from "../services/pricing";
import { notifyUser } from "../services/push";
import { emptyToNull } from "../validation/fields";
import { TrackingSchema } from "./orderController";

const ListSchema = z.object({ status: z.enum([...MERCHANT_STATUSES, "all"]).default("all") });

const ReasonSchema = z.object({
  reason: z
    .string({ error: "Give a reason of at least 5 characters." })
    .trim()
    .min(5, "Give a reason of at least 5 characters.")
    .max(300, "Keep the reason under 300 characters."),
});

const CommissionSchema = z.object({
  commissionPercent: z.preprocess(
    emptyToNull,
    z.coerce
      .number({ error: "Commission must be a number." })
      .min(0, "Commission can't be negative.")
      .max(100, "Commission can't be more than 100%.")
      .nullable()
  ),
});

const SettingsSchema = z.object({
  defaultCommissionPercent: z.coerce
    .number({ error: "Commission must be a number." })
    .min(0, "Commission can't be negative.")
    .max(100, "Commission can't be more than 100%."),
  returnWindowDays: z.coerce.number().int().min(1, "The returns window must be at least 1 day.").max(30, "The returns window can be at most 30 days."),
  merchantResponseHours: z.coerce.number().int().min(12, "Give merchants at least 12 hours.").max(168, "Give merchants at most 7 days."),
  payoutsEnabled: z.boolean(),
});

const VisibilitySchema = z.object({ hidden: z.boolean({ error: "Say whether the product is hidden." }) });

function toAdminMerchant(merchant: any, defaultCommissionPercent: number) {
  return {
    _id: merchant._id,
    owner: merchant.user ? { email: merchant.user.email, username: merchant.user.username } : null,
    businessName: merchant.businessName,
    description: merchant.description,
    phone: merchant.phone,
    email: merchant.email,
    state: merchant.state,
    address: merchant.address,
    cacNumber: merchant.cacNumber ?? "",
    status: merchant.status,
    statusReason: merchant.statusReason,
    bank: {
      bankName: merchant.bank.bankName,
      accountName: merchant.bank.accountName,
      accountNumberLast4: merchant.bank.accountNumberLast4,
    },
    deliveryFee: toNaira(merchant.deliveryFeeKobo),
    commissionPercent: merchant.commissionPercent,
    effectiveCommissionPercent: merchant.commissionPercent ?? defaultCommissionPercent,
    ratingAverage: merchant.ratingAverage,
    ratingCount: merchant.ratingCount,
    reviewedAt: merchant.reviewedAt,
    createdAt: merchant.createdAt,
  };
}

// GET /api/admin/merchants?status=
export const listMerchants = async (req: Request, res: Response) => {
  const { status } = ListSchema.parse(req.query);
  const [merchants, settings] = await Promise.all([
    Merchant.find(status === "all" ? {} : { status }).populate("user", "email username").sort({ createdAt: -1 }).lean(),
    getMarketplaceSettings(),
  ]);
  res.json(merchants.map((merchant) => toAdminMerchant(merchant, settings.defaultCommissionPercent)));
};

// GET /api/admin/merchants/:id
export const getMerchantDetail = async (req: Request, res: Response) => {
  const merchant = await Merchant.findById(req.params.id).populate("user", "email username").lean();
  if (!merchant) throw new HttpError(404, "Merchant not found");

  const [settings, products, openOrders] = await Promise.all([
    getMarketplaceSettings(),
    ProductTemplate.countDocuments({ merchant: merchant._id }),
    Fulfilment.countDocuments({ merchant: merchant._id, status: { $in: ["paid", "shipped"] } }),
  ]);

  let idDocument: string | null = null;
  try {
    idDocument = idDocumentUrl(merchant.idDocument.publicId, merchant.idDocument.format);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
  }

  res.json({ ...toAdminMerchant(merchant, settings.defaultCommissionPercent), idDocumentUrl: idDocument, products, openOrders });
};

// Moves a merchant between statuses, shows or hides their products, and tells the owner.
async function transition(
  req: Request,
  { from, to, reason, title, body, conflict }: {
    from: MerchantStatus[];
    to: MerchantStatus;
    reason?: string;
    title: string;
    body: string;
    conflict: string;
  }
) {
  const merchant = await Merchant.findOneAndUpdate(
    { _id: req.params.id, status: { $in: from } },
    { $set: { status: to, statusReason: reason ?? "", reviewedBy: req.user!._id, reviewedAt: new Date() } },
    { new: true }
  );
  if (!merchant) {
    throw (await Merchant.exists({ _id: req.params.id })) ? new HttpError(409, conflict) : new HttpError(404, "Merchant not found");
  }

  await ProductTemplate.updateMany({ merchant: merchant._id }, { $set: { sellerActive: to === "approved" } });
  notifyUser({ userId: String(merchant.user), title, body, data: { type: "merchant" } });
  return merchant;
}

const respond = async (res: Response, merchant: IMerchant, message: string) => {
  const settings = await getMarketplaceSettings();
  res.json({ message, merchant: toAdminMerchant(merchant.toObject(), settings.defaultCommissionPercent) });
};

// POST /api/admin/merchants/:id/approve
export const approveMerchant = async (req: Request, res: Response) => {
  const merchant = await transition(req, {
    from: ["pending", "rejected"],
    to: "approved",
    title: "You're approved to sell on Impressa",
    body: "Open merchant mode in the app to add your first products.",
    conflict: "Only pending or rejected applications can be approved.",
  });
  await respond(res, merchant, "Merchant approved");
};

// POST /api/admin/merchants/:id/reject
export const rejectMerchant = async (req: Request, res: Response) => {
  const { reason } = ReasonSchema.parse(req.body ?? {});
  const merchant = await transition(req, {
    from: ["pending"],
    to: "rejected",
    reason,
    title: "Your seller application wasn't approved",
    body: reason,
    conflict: "Only pending applications can be rejected.",
  });
  await respond(res, merchant, "Application rejected");
};

// POST /api/admin/merchants/:id/suspend
export const suspendMerchant = async (req: Request, res: Response) => {
  const { reason } = ReasonSchema.parse(req.body ?? {});
  const merchant = await transition(req, {
    from: ["approved"],
    to: "suspended",
    reason,
    title: "Your merchant account is suspended",
    body: `${reason} Your products are hidden until this is resolved.`,
    conflict: "Only approved merchants can be suspended.",
  });
  await respond(res, merchant, "Merchant suspended");
};

// POST /api/admin/merchants/:id/reinstate
export const reinstateMerchant = async (req: Request, res: Response) => {
  const merchant = await transition(req, {
    from: ["suspended"],
    to: "approved",
    title: "Your merchant account is active again",
    body: "Your products are visible to customers again.",
    conflict: "Only suspended merchants can be reinstated.",
  });
  await respond(res, merchant, "Merchant reinstated");
};

// PUT /api/admin/merchants/:id/commission — null returns the merchant to the default rate.
export const setMerchantCommission = async (req: Request, res: Response) => {
  const { commissionPercent } = CommissionSchema.parse(req.body ?? {});
  const merchant = await Merchant.findByIdAndUpdate(req.params.id, { commissionPercent }, { new: true });
  if (!merchant) throw new HttpError(404, "Merchant not found");
  await respond(res, merchant, "Commission saved. It applies to new orders.");
};

// GET /api/admin/marketplace/settings
export const getAdminMarketplaceSettings = async (_req: Request, res: Response) => {
  const settings = await getMarketplaceSettings();
  res.json({
    defaultCommissionPercent: settings.defaultCommissionPercent,
    returnWindowDays: settings.returnWindowDays,
    merchantResponseHours: settings.merchantResponseHours,
    payoutsEnabled: settings.payoutsEnabled,
  });
};

// PUT /api/admin/marketplace/settings
export const updateMarketplaceSettings = async (req: Request, res: Response) => {
  const input = SettingsSchema.parse(req.body ?? {});
  await getMarketplaceSettings();
  const settings = await MarketplaceSettings.findOneAndUpdate({ key: "marketplace" }, { $set: input }, { new: true });
  res.json({ message: "Marketplace settings saved", settings: input, updatedAt: settings?.get("updatedAt") });
};

// PATCH /api/admin/fulfilments/:id — admins can update any seller's parcel.
export const overrideFulfilment = async (req: Request, res: Response) => {
  const { tracking } = TrackingSchema.parse(req.body ?? {});
  const fulfilment = await updateFulfilmentTracking(req.params.id, tracking);
  if (!fulfilment) throw new HttpError(404, "Parcel not found");
  const settings = await getMarketplaceSettings();
  res.json({ message: "Parcel updated", fulfilment: toAdminFulfilment(fulfilment.toObject(), settings.returnWindowDays) });
};

// PATCH /api/admin/products/:id/visibility
export const setProductVisibility = async (req: Request, res: Response) => {
  const { hidden } = VisibilitySchema.parse(req.body ?? {});
  const product = await ProductTemplate.findByIdAndUpdate(req.params.id, { hidden }, { new: true });
  if (!product) throw new HttpError(404, "Product not found");
  res.json({ message: hidden ? "Product hidden" : "Product visible", product });
};
