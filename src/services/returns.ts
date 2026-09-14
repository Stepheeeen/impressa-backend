import { HttpError } from "../middleware/errorHandler";
import Fulfilment from "../models/Fulfilment";
import Merchant from "../models/Merchant";
import Order from "../models/Order";
import ReturnRequest, { IReturnRequest, OPEN_RETURN_STATUSES, ReturnReason, ReturnStatus } from "../models/ReturnRequest";
import { getMarketplaceSettings } from "./marketplaceSettings";
import { formatNaira, toNaira } from "./pricing";
import { notifyUser, orderNumber } from "./push";
import { paidItemsValueKobo, RefundDestination, refundOrderAmount } from "./refunds";
import { daysFromNow, formatLagosDate, hoursFromNow } from "./time";

// How long a customer has to ask Impressa to review a return the seller turned down.
const ESCALATION_WINDOW_HOURS = 72;

type ReturnInput = {
  userId: string;
  fulfilmentId: string;
  items: { index: number; quantity: number }[];
  reason: ReturnReason;
  details: string;
  photoUrls: string[];
  refundTo: RefundDestination;
};

async function notifyMerchantOwner(merchantId: unknown, title: string, body: string, data: Record<string, unknown>) {
  if (!merchantId) return;
  const merchant = await Merchant.findById(merchantId).select("user").lean();
  if (merchant) notifyUser({ userId: String(merchant.user), title, body, data });
}

// A parcel's payout stays held while any return on it is still being decided.
async function releasePayoutHold(fulfilmentId: unknown) {
  if (await ReturnRequest.exists({ fulfilment: fulfilmentId, open: true })) return;
  await Fulfilment.updateOne({ _id: fulfilmentId, "payout.status": "held" }, { $set: { "payout.status": "pending" } });
}

export async function requestReturn(input: ReturnInput) {
  const fulfilment = await Fulfilment.findOne({ _id: input.fulfilmentId, user: input.userId });
  if (!fulfilment) throw new HttpError(404, "Order not found");
  if (fulfilment.status !== "delivered" || !fulfilment.deliveredAt) {
    throw new HttpError(409, "You can request a return once your items have been delivered.");
  }

  const settings = await getMarketplaceSettings();
  const windowEnds = daysFromNow(settings.returnWindowDays, fulfilment.deliveredAt);
  if (windowEnds <= new Date()) {
    throw new HttpError(409, `Returns for this order closed on ${formatLagosDate(windowEnds)}. Contact Impressa support if something's wrong.`);
  }

  const items = input.items.map(({ index, quantity }) => {
    const item = fulfilment.items[index];
    if (!item) throw new HttpError(400, "Choose items from this order to return.");
    const returnable = item.quantity - (item.returnedQuantity ?? 0);
    if (quantity > returnable) {
      throw new HttpError(400, returnable === 0 ? `${item.title} has already been returned.` : `You can return at most ${returnable} of ${item.title}.`);
    }
    return { index, title: item.title, quantity, unitPriceKobo: item.unitPriceKobo };
  });

  const alreadyOpen = new HttpError(409, "You already have a return in progress for this parcel.");
  if (await ReturnRequest.exists({ fulfilment: fulfilment._id, open: true })) throw alreadyOpen;

  // Impressa's own parcels go straight to the Impressa team.
  const sentToAdmin = !fulfilment.merchant;
  let request: IReturnRequest;
  try {
    request = await ReturnRequest.create({
      fulfilment: fulfilment._id,
      order: fulfilment.order,
      user: fulfilment.user,
      merchant: fulfilment.merchant,
      items,
      itemsValueKobo: items.reduce((sum, item) => sum + item.unitPriceKobo * item.quantity, 0),
      reason: input.reason,
      details: input.details,
      photoUrls: input.photoUrls,
      refundTo: input.refundTo,
      // Faulty or wrong items are the seller's cost to collect; change-of-mind returns are the customer's.
      returnShippingPaidBy: input.reason === "changed-mind" ? "customer" : "merchant",
      status: sentToAdmin ? "escalated" : "requested",
      merchantRespondBy: hoursFromNow(settings.merchantResponseHours),
    });
  } catch (err: any) {
    if (err?.code === 11000) throw alreadyOpen;
    throw err;
  }

  await Fulfilment.updateOne({ _id: fulfilment._id, "payout.status": "pending" }, { $set: { "payout.status": "held" } });
  await notifyMerchantOwner(
    fulfilment.merchant,
    "Return requested",
    `A customer wants to return ${items.length} item${items.length === 1 ? "" : "s"} from order #${orderNumber(String(fulfilment.order))}. Respond by ${formatLagosDate(request.merchantRespondBy)}.`,
    { type: "merchant-return", returnId: String(request._id) }
  );
  return request;
}

// Takes refunded items out of the merchant's payout. The delivery fee stays with the merchant.
async function applyReturnToFulfilment(request: IReturnRequest) {
  const fulfilment = await Fulfilment.findById(request.fulfilment);
  if (!fulfilment) return;

  const refundedItemsKobo = (fulfilment.refundedItemsKobo ?? 0) + request.itemsValueKobo;
  const keptItemsKobo = Math.max(0, fulfilment.itemsSubtotalKobo - refundedItemsKobo);
  const commissionKobo = Math.floor((keptItemsKobo * fulfilment.commissionPercent) / 100);

  await Fulfilment.updateOne(
    { _id: fulfilment._id },
    {
      $inc: Object.fromEntries(request.items.map((item) => [`items.${item.index}.returnedQuantity`, item.quantity])),
      $set: {
        refundedItemsKobo,
        commissionKobo,
        payoutKobo: fulfilment.merchant ? keptItemsKobo - commissionKobo + fulfilment.deliveryFeeKobo : 0,
      },
    }
  );
  await releasePayoutHold(fulfilment._id);
}

// Refunds the customer for an approved return. Rolls the decision back if the refund can't be made.
async function approve(returnId: string, from: ReturnStatus[], decision: Record<string, unknown>) {
  const before = await ReturnRequest.findOneAndUpdate(
    { _id: returnId, status: { $in: from } },
    { $set: { ...decision, status: "refunded", open: false, decidedAt: new Date() } }
  );
  if (!before) return null;

  const order = await Order.findById(before.order).lean();
  const refundKobo = paidItemsValueKobo(order, before.itemsValueKobo);

  let refund;
  try {
    refund = await refundOrderAmount({
      orderId: String(before.order),
      amountKobo: refundKobo,
      destination: before.refundTo,
      idempotencyKey: `return:${before._id}`,
      note: `Return ${before._id}`,
    });
  } catch (err) {
    await ReturnRequest.updateOne({ _id: before._id }, { $set: { status: before.status, open: true, decidedAt: null } });
    throw err;
  }

  const request = await ReturnRequest.findByIdAndUpdate(
    before._id,
    { $set: { refund: { amountKobo: refundKobo, ...refund, completedAt: new Date() } } },
    { new: true }
  );
  await applyReturnToFulfilment(before);

  const where =
    refund.cardKobo > 0 && refund.walletKobo > 0
      ? `${formatNaira(refund.cardKobo)} to your card and ${formatNaira(refund.walletKobo)} to your wallet`
      : refund.cardKobo > 0
        ? "to your card. It can take up to 10 working days to show"
        : "to your Impressa wallet";
  notifyUser({
    userId: String(before.user),
    title: "Return approved",
    body: `${formatNaira(refundKobo)} refunded ${where}.`,
    data: { type: "order", orderId: String(before.order) },
  });
  return request;
}

export async function merchantAcceptReturn(returnId: string, merchantId: unknown, note: string) {
  if (!(await ReturnRequest.exists({ _id: returnId, merchant: merchantId }))) return null;
  return approve(returnId, ["requested"], { merchantNote: note, merchantRespondedAt: new Date() });
}

export async function merchantRejectReturn(returnId: string, merchantId: unknown, note: string) {
  const request = await ReturnRequest.findOneAndUpdate(
    { _id: returnId, merchant: merchantId, status: "requested" },
    {
      $set: {
        status: "rejected-by-merchant",
        merchantNote: note,
        merchantRespondedAt: new Date(),
        customerEscalateBy: hoursFromNow(ESCALATION_WINDOW_HOURS),
      },
    },
    { new: true }
  );
  if (!request) return null;

  notifyUser({
    userId: String(request.user),
    title: "The seller declined your return",
    body: `You can ask Impressa to review it until ${formatLagosDate(request.customerEscalateBy!)}.`,
    data: { type: "return", returnId: String(request._id) },
  });
  return request;
}

export async function escalateReturn(returnId: string, userId: string, note: string) {
  return ReturnRequest.findOneAndUpdate(
    { _id: returnId, user: userId, status: "rejected-by-merchant", customerEscalateBy: { $gt: new Date() } },
    { $set: { status: "escalated", customerNote: note } },
    { new: true }
  );
}

export async function adminApproveReturn(returnId: string, adminId: unknown, note: string) {
  return approve(returnId, OPEN_RETURN_STATUSES, { adminNote: note, decidedBy: adminId });
}

export async function adminDeclineReturn(returnId: string, adminId: unknown, note: string) {
  const request = await ReturnRequest.findOneAndUpdate(
    { _id: returnId, status: { $in: OPEN_RETURN_STATUSES } },
    { $set: { status: "declined", open: false, adminNote: note, decidedBy: adminId, decidedAt: new Date() } },
    { new: true }
  );
  if (!request) return null;

  await releasePayoutHold(request.fulfilment);
  notifyUser({
    userId: String(request.user),
    title: "Return not approved",
    body: note,
    data: { type: "return", returnId: String(request._id) },
  });
  return request;
}

// Sends returns the seller didn't answer in time to the Impressa team.
export async function escalateOverdueReturns(now = new Date()) {
  const overdue = await ReturnRequest.find({ status: "requested", merchantRespondBy: { $lte: now } }).select("_id user").lean();
  for (const request of overdue) {
    const escalated = await ReturnRequest.updateOne({ _id: request._id, status: "requested" }, { $set: { status: "escalated" } });
    if (escalated.modifiedCount === 1) {
      notifyUser({
        userId: String(request.user),
        title: "We're reviewing your return",
        body: "The seller didn't respond in time, so the Impressa team will decide.",
        data: { type: "return", returnId: String(request._id) },
      });
    }
  }
  return overdue.length;
}

// Closes returns the seller declined when the customer didn't ask for a review in time.
export async function closeUnescalatedReturns(now = new Date()) {
  const expired = await ReturnRequest.find({ status: "rejected-by-merchant", customerEscalateBy: { $lte: now } })
    .select("_id fulfilment")
    .lean();
  for (const request of expired) {
    const closed = await ReturnRequest.updateOne(
      { _id: request._id, status: "rejected-by-merchant" },
      { $set: { status: "declined", open: false, decidedAt: now } }
    );
    if (closed.modifiedCount === 1) await releasePayoutHold(request.fulfilment);
  }
  return expired.length;
}

export function toReturnResponse(request: any, audience: "customer" | "merchant" | "admin") {
  return {
    _id: request._id,
    orderId: request.order?._id ?? request.order,
    orderNumber: orderNumber(String(request.order?._id ?? request.order)),
    fulfilmentId: request.fulfilment?._id ?? request.fulfilment,
    items: request.items.map((item: any) => ({ title: item.title, quantity: item.quantity, unitPrice: toNaira(item.unitPriceKobo) })),
    itemsValue: toNaira(request.itemsValueKobo),
    reason: request.reason,
    details: request.details,
    photoUrls: request.photoUrls,
    refundTo: request.refundTo,
    returnShippingPaidBy: request.returnShippingPaidBy,
    status: request.status,
    merchantRespondBy: request.merchantRespondBy,
    merchantNote: request.merchantNote,
    customerEscalateBy: request.customerEscalateBy,
    customerNote: request.customerNote,
    adminNote: audience === "merchant" ? undefined : request.adminNote,
    refund: request.refund
      ? {
          amount: toNaira(request.refund.amountKobo),
          toCard: toNaira(request.refund.cardKobo),
          toWallet: toNaira(request.refund.walletKobo),
          completedAt: request.refund.completedAt,
        }
      : null,
    sellerName: request.fulfilment?.sellerName,
    customerName: audience === "customer" ? undefined : request.user?.username,
    createdAt: request.createdAt,
  };
}
