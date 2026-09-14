import mongoose from "mongoose";
import { HttpError } from "../middleware/errorHandler";
import Fulfilment from "../models/Fulfilment";
import Merchant from "../models/Merchant";
import ProductTemplate from "../models/ProductTemplate";
import Review from "../models/Review";
import User from "../models/User";

const round1 = (value: number) => Math.round(value * 10) / 10;

// Recalculates the average rating shown on a product and its seller.
export async function refreshRatings(productId: unknown, merchantId: unknown) {
  const summarise = async (match: Record<string, unknown>) => {
    const [row] = await Review.aggregate<{ average: number; count: number }>([
      { $match: match },
      { $group: { _id: null, average: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]);
    return { ratingAverage: row ? round1(row.average) : 0, ratingCount: row?.count ?? 0 };
  };

  await ProductTemplate.updateOne({ _id: productId }, { $set: await summarise({ product: new mongoose.Types.ObjectId(String(productId)) }) });
  if (merchantId) {
    await Merchant.updateOne({ _id: merchantId }, { $set: await summarise({ merchant: new mongoose.Types.ObjectId(String(merchantId)) }) });
  }
}

// Only customers who received the item can review it, once per order.
export async function createReview({
  userId,
  fulfilmentId,
  templateId,
  rating,
  comment,
}: {
  userId: string;
  fulfilmentId: string;
  templateId: string;
  rating: number;
  comment: string;
}) {
  const fulfilment = await Fulfilment.findOne({ _id: fulfilmentId, user: userId }).lean();
  if (!fulfilment) throw new HttpError(404, "Order not found");
  if (fulfilment.status !== "delivered") throw new HttpError(409, "You can review items once they've been delivered.");
  if (!fulfilment.items.some((item) => String(item.templateId) === templateId)) {
    throw new HttpError(400, "That item isn't in this order.");
  }

  const user = await User.findById(userId).select("username").lean();
  const authorName = (user?.username ?? "Customer").split(/[\s._]/)[0] || "Customer";

  try {
    const review = await Review.create({
      product: templateId,
      merchant: fulfilment.merchant,
      user: userId,
      fulfilment: fulfilment._id,
      rating,
      comment,
      authorName,
    });
    await refreshRatings(templateId, fulfilment.merchant);
    return review;
  } catch (err: any) {
    if (err?.code === 11000) throw new HttpError(409, "You've already reviewed this item.");
    throw err;
  }
}
