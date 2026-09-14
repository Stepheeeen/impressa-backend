import { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import { isObjectId } from "../middleware/validate";
import Banner, { BANNER_LINK_TYPES } from "../models/Banner";
import PriceBand from "../models/PriceBand";
import ProductTemplate from "../models/ProductTemplate";

const HOME_PRODUCT_LIMIT = 10;

// Admin forms send "" for an empty date or price.
const emptyToNull = (value: unknown) => (value === "" || value === undefined ? null : value);

const optionalDate = z.preprocess(emptyToNull, z.coerce.date({ error: "Enter a valid date." }).nullable());

const BannerSchema = z
  .object({
    title: z
      .string({ error: "Add a banner title." })
      .trim()
      .min(1, "Add a banner title.")
      .max(80, "Keep the title under 80 characters."),
    subtitle: z.string().trim().max(140, "Keep the subtitle under 140 characters.").default(""),
    imageUrl: z.string({ error: "Upload a banner image." }).trim().regex(/^https:\/\/\S+$/, "Upload a banner image."),
    linkType: z.enum(BANNER_LINK_TYPES, { error: "Choose what the banner opens." }).default("none"),
    linkValue: z.string().trim().max(100).default(""),
    startsAt: optionalDate,
    endsAt: optionalDate,
    sortOrder: z.coerce.number().int().min(0).default(0),
    active: z.boolean().default(true),
  })
  .superRefine((banner, ctx) => {
    if (banner.linkType === "product" && !isObjectId(banner.linkValue)) {
      ctx.addIssue({ code: "custom", path: ["linkValue"], message: "Choose the product this banner opens." });
    }
    if (banner.linkType === "priceBand" && !isObjectId(banner.linkValue)) {
      ctx.addIssue({ code: "custom", path: ["linkValue"], message: "Choose the price band this banner opens." });
    }
    if (banner.linkType === "category" && !banner.linkValue) {
      ctx.addIssue({ code: "custom", path: ["linkValue"], message: "Choose the category this banner opens." });
    }
    if (banner.startsAt && banner.endsAt && banner.endsAt <= banner.startsAt) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end date must be after the start date." });
    }
  });

const PriceBandSchema = z
  .object({
    label: z
      .string({ error: "Add a label, e.g. Under ₦5,000." })
      .trim()
      .min(1, "Add a label, e.g. Under ₦5,000.")
      .max(40, "Keep the label under 40 characters."),
    minPrice: z.preprocess(
      (value) => (value === "" || value === undefined ? 0 : value),
      z.coerce
        .number({ error: "Minimum price must be a number." })
        .int("Use whole naira amounts.")
        .min(0, "Minimum price can't be negative.")
    ),
    maxPrice: z.preprocess(
      emptyToNull,
      z.coerce
        .number({ error: "Maximum price must be a number." })
        .int("Use whole naira amounts.")
        .positive("Maximum price must be above zero.")
        .nullable()
    ),
    sortOrder: z.coerce.number().int().min(0).default(0),
    active: z.boolean().default(true),
  })
  .refine((band) => band.maxPrice === null || band.maxPrice > band.minPrice, {
    path: ["maxPrice"],
    message: "Maximum price must be higher than the minimum.",
  });

type BannerInput = z.infer<typeof BannerSchema>;

async function checkBannerLink(banner: BannerInput) {
  if (banner.linkType === "product" && !(await ProductTemplate.exists({ _id: banner.linkValue }))) {
    throw new HttpError(400, "That product doesn't exist.");
  }
  if (banner.linkType === "priceBand" && !(await PriceBand.exists({ _id: banner.linkValue }))) {
    throw new HttpError(400, "That price band doesn't exist.");
  }
}

// Active banners inside their schedule. Missing dates mean no limit.
function liveBannerFilter() {
  const now = new Date();
  return {
    active: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
    ],
  };
}

const BANNER_ORDER = { sortOrder: 1, createdAt: -1 } as const;
const PRICE_BAND_ORDER = { sortOrder: 1, minPrice: 1 } as const;

// GET /api/banners
export const getLiveBanners = async (_req: Request, res: Response) => {
  res.json(await Banner.find(liveBannerFilter()).sort(BANNER_ORDER).lean());
};

// GET /api/price-bands
export const getPriceBands = async (_req: Request, res: Response) => {
  res.json(await PriceBand.find({ active: true }).sort(PRICE_BAND_ORDER).lean());
};

// GET /api/home — everything the app's home screen needs in one request, for slow connections.
export const getHome = async (_req: Request, res: Response) => {
  const inStock = { inStock: { $ne: false } };
  const [banners, priceBands, featured, categories] = await Promise.all([
    Banner.find(liveBannerFilter()).sort(BANNER_ORDER).lean(),
    PriceBand.find({ active: true }).sort(PRICE_BAND_ORDER).lean(),
    ProductTemplate.find({ ...inStock, isFeatured: true }).sort({ updatedAt: -1 }).limit(HOME_PRODUCT_LIMIT).lean(),
    ProductTemplate.distinct("category"),
  ]);

  const products =
    featured.length > 0
      ? featured
      : await ProductTemplate.find(inStock).sort({ createdAt: -1 }).limit(HOME_PRODUCT_LIMIT).lean();

  res.set("Cache-Control", "public, max-age=60");
  res.json({
    banners,
    priceBands,
    featured: products,
    featuredIsFallback: featured.length === 0,
    categories: [...new Set(categories.map((category) => String(category).trim().toLowerCase()).filter(Boolean))],
  });
};

// GET /api/admin/banners
export const listBanners = async (_req: Request, res: Response) => {
  res.json(await Banner.find().sort(BANNER_ORDER).lean());
};

// POST /api/admin/banners
export const createBanner = async (req: Request, res: Response) => {
  const input = BannerSchema.parse(req.body ?? {});
  await checkBannerLink(input);
  const banner = await Banner.create(input);
  res.status(201).json({ message: "Banner created", banner });
};

// PUT /api/admin/banners/:id
export const updateBanner = async (req: Request, res: Response) => {
  const input = BannerSchema.parse(req.body ?? {});
  await checkBannerLink(input);
  const banner = await Banner.findByIdAndUpdate(req.params.id, input, { new: true });
  if (!banner) throw new HttpError(404, "Banner not found");
  res.json({ message: "Banner updated", banner });
};

// DELETE /api/admin/banners/:id
export const deleteBanner = async (req: Request, res: Response) => {
  const banner = await Banner.findByIdAndDelete(req.params.id);
  if (!banner) throw new HttpError(404, "Banner not found");
  res.json({ message: "Banner deleted" });
};

// GET /api/admin/price-bands
export const listPriceBands = async (_req: Request, res: Response) => {
  res.json(await PriceBand.find().sort(PRICE_BAND_ORDER).lean());
};

// POST /api/admin/price-bands
export const createPriceBand = async (req: Request, res: Response) => {
  const priceBand = await PriceBand.create(PriceBandSchema.parse(req.body ?? {}));
  res.status(201).json({ message: "Price band created", priceBand });
};

// PUT /api/admin/price-bands/:id
export const updatePriceBand = async (req: Request, res: Response) => {
  const priceBand = await PriceBand.findByIdAndUpdate(req.params.id, PriceBandSchema.parse(req.body ?? {}), { new: true });
  if (!priceBand) throw new HttpError(404, "Price band not found");
  res.json({ message: "Price band updated", priceBand });
};

// DELETE /api/admin/price-bands/:id
export const deletePriceBand = async (req: Request, res: Response) => {
  if (await Banner.exists({ linkType: "priceBand", linkValue: req.params.id })) {
    throw new HttpError(409, "A banner links to this price band. Change or delete that banner first.");
  }
  const priceBand = await PriceBand.findByIdAndDelete(req.params.id);
  if (!priceBand) throw new HttpError(404, "Price band not found");
  res.json({ message: "Price band deleted" });
};
