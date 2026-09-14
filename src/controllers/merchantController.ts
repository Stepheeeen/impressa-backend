import bcrypt from "bcryptjs";
import { Request, Response } from "express";
import { z } from "zod";
import { NIGERIA_STATES } from "../constants/nigeria";
import { HttpError } from "../middleware/errorHandler";
import Fulfilment from "../models/Fulfilment";
import Merchant, { IMerchant } from "../models/Merchant";
import ProductTemplate from "../models/ProductTemplate";
import User from "../models/User";
import { isIdDocumentPublicId, signIdDocumentUpload } from "../services/cloudinary";
import { updateFulfilmentTracking } from "../services/fulfilments";
import { getMarketplaceSettings } from "../services/marketplaceSettings";
import { createTransferRecipient, listBanks, resolveBankAccount } from "../services/paystack";
import { toKobo, toNaira } from "../services/pricing";
import { notifyUser, orderNumber } from "../services/push";
import { emptyToNull } from "../validation/fields";
import { TrackingSchema } from "./orderController";

const phoneField = z
  .string({ error: "Enter a phone number." })
  .trim()
  .regex(/^\+?[0-9][0-9\s-]{9,15}$/, "Enter a valid phone number.");

const deliveryFeeField = z.coerce
  .number({ error: "Delivery fee must be a number." })
  .min(0, "Delivery fee can't be negative.")
  .max(50_000, "Delivery fee can be at most ₦50,000.");

const BankAccountSchema = z.object({
  bankCode: z.string({ error: "Choose your bank." }).trim().regex(/^[0-9A-Za-z]{2,10}$/, "Choose your bank."),
  accountNumber: z.string({ error: "Enter your account number." }).trim().regex(/^\d{10}$/, "Account numbers are 10 digits."),
});

const ApplicationSchema = BankAccountSchema.extend({
  businessName: z.string({ error: "Enter your business name." }).trim().min(2, "Enter your business name.").max(80),
  description: z.string().trim().max(500, "Keep the description under 500 characters.").default(""),
  phone: phoneField,
  email: z.string({ error: "Enter an email address." }).trim().toLowerCase().pipe(z.email("Enter a valid email address.")),
  state: z.enum(NIGERIA_STATES, { error: "Choose your state." }),
  address: z.string({ error: "Enter your business address." }).trim().min(5, "Enter your business address.").max(300),
  cacNumber: z.string().trim().max(20).default(""),
  idDocumentPublicId: z.string({ error: "Upload a photo of your ID." }).trim().min(1, "Upload a photo of your ID."),
  idDocumentFormat: z.string().trim().regex(/^[a-z0-9]{2,5}$/i).default("jpg"),
  deliveryFee: deliveryFeeField,
});

const ProfileSchema = z.object({
  description: z.string().trim().max(500, "Keep the description under 500 characters.").default(""),
  phone: phoneField,
  deliveryFee: deliveryFeeField,
});

const ChangeBankSchema = BankAccountSchema.extend({
  password: z.string({ error: "Enter your password to confirm." }).min(1, "Enter your password to confirm."),
});

const httpsUrl = (message: string) => z.string().trim().regex(/^https:\/\/\S+$/, message);
const textList = z.array(z.string().trim().min(1).max(30)).max(20).default([]);

const ProductSchema = z.object({
  title: z.string({ error: "Add a product name." }).trim().min(2, "Add a product name.").max(120),
  category: z.string({ error: "Choose a category." }).trim().toLowerCase().min(2, "Choose a category.").max(40),
  itemType: z.string({ error: "Choose an item type." }).trim().toLowerCase().min(2, "Choose an item type.").max(40),
  description: z.string().trim().max(2000, "Keep the description under 2,000 characters.").default(""),
  price: z.coerce.number({ error: "Price must be a number." }).positive("Price must be above zero.").max(10_000_000),
  imageUrls: z
    .array(httpsUrl("Photos must be uploaded images."))
    .min(1, "Add at least one photo.")
    .max(8, "Use at most 8 photos."),
  videoUrl: z.preprocess(emptyToNull, httpsUrl("Video must be an uploaded video.").nullable()),
  sizes: textList,
  colors: textList,
  tags: textList,
  stockQuantity: z.coerce
    .number({ error: "Stock must be a number." })
    .int("Stock must be a whole number.")
    .min(0, "Stock can't be negative.")
    .max(100_000),
});

const StockSchema = z.object({ stockQuantity: ProductSchema.shape.stockQuantity });

const FulfilmentListSchema = z.object({
  status: z.enum(["to-ship", "shipped", "delivered", "cancelled", "all"]).default("to-ship"),
});

function toMerchantResponse(merchant: IMerchant, defaultCommissionPercent: number) {
  return {
    _id: merchant._id,
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
    commissionPercent: merchant.commissionPercent ?? defaultCommissionPercent,
    ratingAverage: merchant.ratingAverage,
    ratingCount: merchant.ratingCount,
  };
}

// Confirms the account with the bank and saves it on Paystack for payouts.
async function verifyPayoutAccount(bankCode: string, accountNumber: string) {
  const bank = (await listBanks()).find((b) => b.code === bankCode);
  if (!bank) throw new HttpError(400, "Choose your bank.");
  const { accountName } = await resolveBankAccount(accountNumber, bankCode);
  const recipientCode = await createTransferRecipient({ name: accountName, accountNumber, bankCode });
  return {
    bankCode,
    bankName: bank.name,
    accountName,
    accountNumberLast4: accountNumber.slice(-4),
    recipientCode,
  };
}

// GET /api/merchant/banks
export const getBanks = async (_req: Request, res: Response) => {
  res.json(await listBanks());
};

// POST /api/merchant/bank/resolve — shows the account name before the applicant submits.
export const resolveAccount = async (req: Request, res: Response) => {
  const { bankCode, accountNumber } = BankAccountSchema.parse(req.body ?? {});
  const { accountName } = await resolveBankAccount(accountNumber, bankCode);
  res.json({ accountName });
};

// POST /api/merchant/id-upload-signature
export const getIdUploadSignature = async (_req: Request, res: Response) => {
  res.json(signIdDocumentUpload());
};

// POST /api/merchant/application
export const applyToSell = async (req: Request, res: Response) => {
  const input = ApplicationSchema.parse(req.body ?? {});
  if (!isIdDocumentPublicId(input.idDocumentPublicId)) throw new HttpError(400, "Upload a photo of your ID.");

  const user = req.user!;
  const existing = await Merchant.findOne({ user: user._id });
  if (existing && existing.status !== "rejected") {
    throw new HttpError(
      409,
      existing.status === "pending" ? "Your application is already being reviewed." : "You already have a merchant account."
    );
  }

  const fields = {
    user: user._id,
    businessName: input.businessName,
    description: input.description,
    phone: input.phone,
    email: input.email,
    state: input.state,
    address: input.address,
    cacNumber: input.cacNumber,
    idDocument: { publicId: input.idDocumentPublicId, format: input.idDocumentFormat.toLowerCase() },
    bank: await verifyPayoutAccount(input.bankCode, input.accountNumber),
    deliveryFeeKobo: toKobo(input.deliveryFee),
    status: "pending",
    statusReason: "",
    reviewedBy: null,
    reviewedAt: null,
  };

  const merchant = existing
    ? await Merchant.findByIdAndUpdate(existing._id, fields, { new: true })
    : await Merchant.create(fields);

  const settings = await getMarketplaceSettings();
  res.status(201).json({
    message: "Application sent. We'll let you know once it's been reviewed.",
    merchant: toMerchantResponse(merchant!, settings.defaultCommissionPercent),
  });
};

// GET /api/merchant/me
export const getMyMerchant = async (req: Request, res: Response) => {
  const merchant = await Merchant.findOne({ user: req.user!._id });
  if (!merchant) throw new HttpError(404, "You haven't applied to sell yet.");
  const settings = await getMarketplaceSettings();
  res.json(toMerchantResponse(merchant, settings.defaultCommissionPercent));
};

// PUT /api/merchant/me
export const updateMyMerchant = async (req: Request, res: Response) => {
  const input = ProfileSchema.parse(req.body ?? {});
  const merchant = await Merchant.findByIdAndUpdate(
    req.merchant!._id,
    { description: input.description, phone: input.phone, deliveryFeeKobo: toKobo(input.deliveryFee) },
    { new: true }
  );
  const settings = await getMarketplaceSettings();
  res.json({ message: "Profile saved", merchant: toMerchantResponse(merchant!, settings.defaultCommissionPercent) });
};

// PUT /api/merchant/me/bank — changing where payouts go needs the password, and the owner is told.
export const changeBankAccount = async (req: Request, res: Response) => {
  const { bankCode, accountNumber, password } = ChangeBankSchema.parse(req.body ?? {});
  const user = await User.findById(req.user!._id);
  // 400 rather than 401: clients treat 401 as an expired session.
  if (!user || !(await bcrypt.compare(password, user.password))) throw new HttpError(400, "Incorrect password.");

  const bank = await verifyPayoutAccount(bankCode, accountNumber);
  const merchant = await Merchant.findByIdAndUpdate(req.merchant!._id, { bank }, { new: true });

  notifyUser({
    userId: user.id,
    title: "Your payout account was changed",
    body: `Payouts now go to ${bank.bankName} ••••${bank.accountNumberLast4}. If this wasn't you, contact Impressa support now.`,
    data: { type: "merchant" },
  });

  const settings = await getMarketplaceSettings();
  res.json({ message: "Payout account updated", merchant: toMerchantResponse(merchant!, settings.defaultCommissionPercent) });
};

// GET /api/merchant/products
export const listMyProducts = async (req: Request, res: Response) => {
  res.json(await ProductTemplate.find({ merchant: req.merchant!._id }).sort({ createdAt: -1 }));
};

// POST /api/merchant/products — goes live straight away; admins can hide it.
export const createMyProduct = async (req: Request, res: Response) => {
  const input = ProductSchema.parse(req.body ?? {});
  const product = await ProductTemplate.create({
    ...input,
    merchant: req.merchant!._id,
    customizable: false,
    isFeatured: false,
    inStock: true,
    hidden: false,
    sellerActive: true,
  });
  res.status(201).json({ message: "Product added", product });
};

// PUT /api/merchant/products/:id
export const updateMyProduct = async (req: Request, res: Response) => {
  const input = ProductSchema.parse(req.body ?? {});
  const product = await ProductTemplate.findOneAndUpdate({ _id: req.params.id, merchant: req.merchant!._id }, input, {
    new: true,
  });
  if (!product) throw new HttpError(404, "Product not found");
  res.json({ message: "Product saved", product });
};

// PATCH /api/merchant/products/:id/stock
export const updateMyProductStock = async (req: Request, res: Response) => {
  const { stockQuantity } = StockSchema.parse(req.body ?? {});
  const product = await ProductTemplate.findOneAndUpdate(
    { _id: req.params.id, merchant: req.merchant!._id },
    { stockQuantity },
    { new: true }
  );
  if (!product) throw new HttpError(404, "Product not found");
  res.json({ message: "Stock updated", product });
};

// DELETE /api/merchant/products/:id — past orders keep their own copy of the item details.
export const deleteMyProduct = async (req: Request, res: Response) => {
  const product = await ProductTemplate.findOneAndDelete({ _id: req.params.id, merchant: req.merchant!._id });
  if (!product) throw new HttpError(404, "Product not found");
  res.json({ message: "Product deleted" });
};

function toMerchantFulfilment(fulfilment: any) {
  return {
    _id: fulfilment._id,
    orderId: fulfilment.order?._id ?? fulfilment.order,
    orderNumber: orderNumber(String(fulfilment.order?._id ?? fulfilment.order)),
    placedAt: fulfilment.order?.createdAt ?? fulfilment.createdAt,
    // Merchants need the customer's name, address and phone to deliver, but never their email.
    customerName: fulfilment.user?.username ?? "Customer",
    deliveryAddress: fulfilment.order?.deliveryAddress ?? null,
    items: fulfilment.items.map((item: any) => ({
      title: item.title,
      quantity: item.quantity,
      unitPrice: toNaira(item.unitPriceKobo),
      size: item.size ?? null,
      color: item.color ?? null,
      imageUrl: item.imageUrl ?? null,
      oversold: Boolean(item.oversold),
    })),
    itemsSubtotal: toNaira(fulfilment.itemsSubtotalKobo),
    deliveryFee: toNaira(fulfilment.deliveryFeeKobo),
    commissionPercent: fulfilment.commissionPercent,
    commission: toNaira(fulfilment.commissionKobo),
    payout: toNaira(fulfilment.payoutKobo),
    payoutStatus: fulfilment.payout?.status,
    status: fulfilment.status,
    statusHistory: fulfilment.statusHistory,
    tracking: fulfilment.tracking ?? null,
    deliveredAt: fulfilment.deliveredAt ?? null,
    needsAttention: fulfilment.needsAttention,
  };
}

const LIST_FILTERS = { "to-ship": ["paid"], shipped: ["shipped"], delivered: ["delivered"], cancelled: ["cancelled"] } as const;

// GET /api/merchant/fulfilments?status=to-ship|shipped|delivered|cancelled|all
export const listMyFulfilments = async (req: Request, res: Response) => {
  const { status } = FulfilmentListSchema.parse(req.query);
  const filter: Record<string, unknown> = { merchant: req.merchant!._id };
  if (status !== "all") filter.status = { $in: LIST_FILTERS[status] };

  const fulfilments = await Fulfilment.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("order", "deliveryAddress createdAt")
    .populate("user", "username")
    .lean();
  res.json(fulfilments.map(toMerchantFulfilment));
};

// PATCH /api/merchant/fulfilments/:id/tracking
export const updateMyFulfilmentTracking = async (req: Request, res: Response) => {
  const { tracking } = TrackingSchema.parse(req.body ?? {});
  const fulfilment = await updateFulfilmentTracking(req.params.id, tracking, { merchant: req.merchant!._id });
  if (!fulfilment) throw new HttpError(404, "Order not found");
  res.json({ message: "Delivery updated", status: fulfilment.status, tracking: fulfilment.tracking ?? null });
};

// GET /api/merchant/summary
export const getMerchantSummary = async (req: Request, res: Response) => {
  const merchant = req.merchant!._id;
  const sumPayouts = async (payoutStatuses: string[]) => {
    const [row] = await Fulfilment.aggregate<{ total: number }>([
      { $match: { merchant, status: "delivered", "payout.status": { $in: payoutStatuses } } },
      { $group: { _id: null, total: { $sum: "$payoutKobo" } } },
    ]);
    return row?.total ?? 0;
  };

  const [toShip, inTransit, needsAttention, pendingPayoutKobo, paidOutKobo] = await Promise.all([
    Fulfilment.countDocuments({ merchant, status: "paid" }),
    Fulfilment.countDocuments({ merchant, status: "shipped" }),
    Fulfilment.countDocuments({ merchant, needsAttention: true, status: { $ne: "cancelled" } }),
    sumPayouts(["pending", "held", "processing"]),
    sumPayouts(["paid"]),
  ]);

  res.json({
    toShip,
    inTransit,
    needsAttention,
    pendingPayout: toNaira(pendingPayoutKobo),
    paidOut: toNaira(paidOutKobo),
  });
};
