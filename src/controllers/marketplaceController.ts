import { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import { isObjectId } from "../middleware/validate";
import Payout, { PAYOUT_RECORD_STATUSES } from "../models/Payout";
import ReturnRequest, { OPEN_RETURN_STATUSES, RETURN_REASONS } from "../models/ReturnRequest";
import Review from "../models/Review";
import { cancelFulfilment } from "../services/fulfilments";
import { sendPayout } from "../services/payouts";
import { toNaira } from "../services/pricing";
import {
  adminApproveReturn,
  adminDeclineReturn,
  escalateReturn,
  merchantAcceptReturn,
  merchantRejectReturn,
  requestReturn,
  toReturnResponse,
} from "../services/returns";
import { createReview, refreshRatings } from "../services/reviews";

const noteField = (minimum: number, message: string) =>
  z.string({ error: message }).trim().min(minimum, message).max(1000, "Keep it under 1,000 characters.");

const ReturnSchema = z.object({
  items: z
    .array(
      z.object({
        index: z.coerce.number().int().min(0),
        quantity: z.coerce.number().int().min(1, "Return at least one of each item you choose."),
      })
    )
    .min(1, "Choose at least one item to return."),
  reason: z.enum(RETURN_REASONS, { error: "Choose why you're returning it." }),
  details: noteField(10, "Tell us what's wrong in at least 10 characters."),
  photoUrls: z.array(z.string().trim().regex(/^https:\/\/\S+$/, "Photos must be uploaded images.")).max(4, "Add at most 4 photos.").default([]),
  refundTo: z.enum(["wallet", "card"], { error: "Choose where your refund goes." }),
});

const OptionalNoteSchema = z.object({ note: z.string().trim().max(1000).default("") });
const RequiredNoteSchema = (message: string) => z.object({ note: noteField(10, message) });
const ReasonSchema = z.object({ reason: noteField(5, "Give a reason of at least 5 characters.") });

const ReviewSchema = z.object({
  fulfilmentId: z.string().refine(isObjectId, "Order not found"),
  templateId: z.string().refine(isObjectId, "That item isn't in this order."),
  rating: z.coerce.number({ error: "Choose a rating from 1 to 5." }).int().min(1, "Choose a rating from 1 to 5.").max(5, "Choose a rating from 1 to 5."),
  comment: z.string().trim().max(1000, "Keep your review under 1,000 characters.").default(""),
});

const ReturnListSchema = z.object({ status: z.enum(["open", "escalated", "all"]).default("open") });
const PayoutListSchema = z.object({ status: z.enum([...PAYOUT_RECORD_STATUSES, "all"]).default("all") });

const returnQuery = (req: Request, extra: Record<string, unknown>) => {
  const { status } = ReturnListSchema.parse(req.query);
  if (status === "open") return { ...extra, status: { $in: OPEN_RETURN_STATUSES } };
  if (status === "escalated") return { ...extra, status: "escalated" };
  return extra;
};

const findReturns = (filter: Record<string, unknown>) =>
  ReturnRequest.find(filter).sort({ createdAt: -1 }).limit(100).populate("fulfilment", "sellerName").populate("user", "username").lean();

// ----- Customers -----

// POST /api/fulfilments/:id/returns
export const createReturn = async (req: Request, res: Response) => {
  const input = ReturnSchema.parse(req.body ?? {});
  const request = await requestReturn({ ...input, userId: req.user!.id, fulfilmentId: req.params.id });
  res.status(201).json({ message: "Return requested. We'll let you know once the seller responds.", return: toReturnResponse(request.toObject(), "customer") });
};

// GET /api/returns
export const listMyReturns = async (req: Request, res: Response) => {
  const returns = await findReturns({ user: req.user!._id });
  res.json(returns.map((request) => toReturnResponse(request, "customer")));
};

// POST /api/returns/:id/escalate
export const escalateMyReturn = async (req: Request, res: Response) => {
  const { note } = RequiredNoteSchema("Tell us why the return should be approved, in at least 10 characters.").parse(req.body ?? {});
  const request = await escalateReturn(req.params.id, req.user!.id, note);
  if (!request) throw new HttpError(409, "This return can't be sent for review. The review period may have ended.");
  res.json({ message: "Sent to the Impressa team for review.", return: toReturnResponse(request.toObject(), "customer") });
};

// POST /api/reviews
export const postReview = async (req: Request, res: Response) => {
  const input = ReviewSchema.parse(req.body ?? {});
  const review = await createReview({ ...input, userId: req.user!.id });
  res.status(201).json({ message: "Thanks for your review.", review: { rating: review.rating, comment: review.comment } });
};

// GET /api/templates/:id/reviews
export const listProductReviews = async (req: Request, res: Response) => {
  const reviews = await Review.find({ product: req.params.id }).sort({ createdAt: -1 }).limit(20).lean();
  res.json(
    reviews.map((review) => ({
      _id: review._id,
      rating: review.rating,
      comment: review.comment,
      authorName: review.authorName,
      createdAt: review.get?.("createdAt") ?? (review as any).createdAt,
    }))
  );
};

// ----- Merchants -----

// GET /api/merchant/returns?status=open|escalated|all
export const listMerchantReturns = async (req: Request, res: Response) => {
  const returns = await findReturns(returnQuery(req, { merchant: req.merchant!._id }));
  res.json(returns.map((request) => toReturnResponse(request, "merchant")));
};

// POST /api/merchant/returns/:id/accept
export const acceptReturn = async (req: Request, res: Response) => {
  const { note } = OptionalNoteSchema.parse(req.body ?? {});
  const request = await merchantAcceptReturn(req.params.id, req.merchant!._id, note);
  if (!request) throw new HttpError(409, "This return has already been answered.");
  res.json({ message: "Return accepted. The customer has been refunded.", return: toReturnResponse(request.toObject(), "merchant") });
};

// POST /api/merchant/returns/:id/reject
export const rejectReturn = async (req: Request, res: Response) => {
  const { note } = RequiredNoteSchema("Explain to the customer why, in at least 10 characters.").parse(req.body ?? {});
  const request = await merchantRejectReturn(req.params.id, req.merchant!._id, note);
  if (!request) throw new HttpError(409, "This return has already been answered.");
  res.json({ message: "Return declined. The customer can ask Impressa to review it.", return: toReturnResponse(request.toObject(), "merchant") });
};

// POST /api/merchant/fulfilments/:id/cancel
export const merchantCancelFulfilment = async (req: Request, res: Response) => {
  const { reason } = ReasonSchema.parse(req.body ?? {});
  const fulfilment = await cancelFulfilment(req.params.id, { reason, scope: { merchant: req.merchant!._id } });
  if (!fulfilment) throw new HttpError(409, "Only orders that haven't shipped can be cancelled.");
  res.json({ message: "Order cancelled. The customer has been refunded.", status: fulfilment.status });
};

const toPayoutResponse = (payout: any) => ({
  _id: payout._id,
  merchant: payout.merchant?.businessName ? { _id: payout.merchant._id, businessName: payout.merchant.businessName } : payout.merchant,
  amount: toNaira(payout.amountKobo),
  orders: payout.fulfilments.length,
  reference: payout.reference,
  status: payout.status,
  failureReason: payout.failureReason || null,
  attempts: payout.attempts,
  paidAt: payout.paidAt,
  createdAt: payout.createdAt,
});

// GET /api/merchant/payouts
export const listMerchantPayouts = async (req: Request, res: Response) => {
  const payouts = await Payout.find({ merchant: req.merchant!._id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json(
    payouts.map((payout) => {
      const { failureReason, attempts, ...visible } = toPayoutResponse(payout);
      // Merchants see that a payout is delayed, not Paystack's internal error.
      return { ...visible, status: payout.status === "failed" ? "delayed" : payout.status };
    })
  );
};

// ----- Admins -----

// GET /api/admin/returns?status=open|escalated|all
export const listAllReturns = async (req: Request, res: Response) => {
  const returns = await findReturns(returnQuery(req, {}));
  res.json(returns.map((request) => toReturnResponse(request, "admin")));
};

// POST /api/admin/returns/:id/approve
export const approveReturnAsAdmin = async (req: Request, res: Response) => {
  const { note } = RequiredNoteSchema("Add a note for the record, at least 10 characters.").parse(req.body ?? {});
  const request = await adminApproveReturn(req.params.id, req.user!._id, note);
  if (!request) throw new HttpError(409, "This return has already been decided.");
  res.json({ message: "Return approved and refunded.", return: toReturnResponse(request.toObject(), "admin") });
};

// POST /api/admin/returns/:id/decline
export const declineReturnAsAdmin = async (req: Request, res: Response) => {
  const { note } = RequiredNoteSchema("Explain the decision to the customer, in at least 10 characters.").parse(req.body ?? {});
  const request = await adminDeclineReturn(req.params.id, req.user!._id, note);
  if (!request) throw new HttpError(409, "This return has already been decided.");
  res.json({ message: "Return declined.", return: toReturnResponse(request.toObject(), "admin") });
};

// POST /api/admin/fulfilments/:id/cancel
export const adminCancelFulfilment = async (req: Request, res: Response) => {
  const { reason } = ReasonSchema.parse(req.body ?? {});
  const fulfilment = await cancelFulfilment(req.params.id, { reason });
  if (!fulfilment) throw new HttpError(409, "Only parcels that haven't shipped can be cancelled.");
  res.json({ message: "Parcel cancelled and refunded.", status: fulfilment.status });
};

// GET /api/admin/payouts?status=
export const listAllPayouts = async (req: Request, res: Response) => {
  const { status } = PayoutListSchema.parse(req.query);
  const payouts = await Payout.find(status === "all" ? {} : { status })
    .sort({ createdAt: -1 })
    .limit(200)
    .populate("merchant", "businessName")
    .lean();
  res.json(payouts.map(toPayoutResponse));
};

// POST /api/admin/payouts/:id/retry
export const retryPayout = async (req: Request, res: Response) => {
  const payout = await Payout.findById(req.params.id).lean();
  if (!payout) throw new HttpError(404, "Payout not found");
  if (payout.status === "paid") throw new HttpError(409, "This payout has already been paid.");
  await sendPayout(String(payout._id));
  const updated = await Payout.findById(payout._id).populate("merchant", "businessName").lean();
  res.json({ message: updated?.status === "paid" ? "Payout sent." : "Retry started.", payout: toPayoutResponse(updated) });
};

// DELETE /api/admin/reviews/:id
export const deleteReview = async (req: Request, res: Response) => {
  const review = await Review.findByIdAndDelete(req.params.id);
  if (!review) throw new HttpError(404, "Review not found");
  await refreshRatings(review.product, review.merchant);
  res.json({ message: "Review removed" });
};
