import * as Sentry from "@sentry/node";
import crypto from "crypto";
import mongoose from "mongoose";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import ProductTemplate from "../models/ProductTemplate";
import SharedCart, { ISharedCart } from "../models/SharedCart";
import SharedCheckout, { ISharedCheckout, PaymentMode, SharePayment } from "../models/SharedCheckout";
import User from "../models/User";
import { ensureStock, findBuyableProduct } from "./cartItems";
import { buildOrderMetadata, CheckoutQuote, MIN_CARD_CHARGE_KOBO, walletLimitKobo } from "./checkout";
import { AppliedCoupon, applyCoupon } from "./coupons";
import { createOrderFromSharedCheckout, PaymentMismatchError } from "./orders";
import { initializeTransaction, refundTransaction } from "./paystack";
import { formatNaira, MAX_ITEM_QUANTITY, PricedCart, priceItems, toCartResponse, toNaira } from "./pricing";
import { notifyUser } from "./push";
import { getRewardSettings } from "./rewardSettings";
import {
  commitHold,
  creditWallet,
  getAvailableCreditKobo,
  holdWalletCredit,
  InsufficientCreditError,
  releaseHold,
  spendFromWallet,
} from "./wallet";
import type { Delivery } from "../validation/delivery";

// Marks Paystack payments for a share of a shared cart, so verify and the webhook route them here.
export const SHARED_CART_PAYMENT = "shared-cart";

const MAX_MEMBERS = 10;
const MAX_ITEMS = 50;
const MAX_CARTS_PER_USER = 20;
const MAX_PAYMENT_ATTEMPTS = 10;
export const SHARE_PAYMENT_HOURS = 24;
// Refunds are the customer's own money, so refund credit effectively never expires.
const REFUND_CREDIT_DAYS = 3650;

const newCode = () => crypto.randomBytes(6).toString("base64url");
const isOwner = (cart: Pick<ISharedCart, "owner">, userId: string) => String(cart.owner) === String(userId);
const lockedError = () =>
  new HttpError(409, "Items can't change while everyone is paying. The owner can cancel the payment to make changes.");

async function userNames(ids: unknown[]) {
  const users = await User.find({ _id: { $in: ids } }).select("username").lean();
  return new Map(users.map((user) => [String(user._id), user.username || "Member"]));
}

// ----- Carts and members -----

// Loads a shared cart the user belongs to. Anyone else gets "not found".
export async function findMemberCart(cartId: string, userId: string) {
  const cart = await SharedCart.findOne({ _id: cartId, "members.user": userId });
  if (!cart) throw new HttpError(404, "Shared cart not found.");
  return cart;
}

async function ensureRoomForAnotherCart(userId: string) {
  if ((await SharedCart.countDocuments({ "members.user": userId })) >= MAX_CARTS_PER_USER) {
    throw new HttpError(429, "You're in too many shared carts. Leave or delete one first.");
  }
}

export async function createSharedCart({ userId, name }: { userId: string; name: string }) {
  await ensureRoomForAnotherCart(userId);
  for (let attempt = 1; ; attempt++) {
    try {
      return await SharedCart.create({ owner: userId, name, code: newCode(), members: [{ user: userId, joinedAt: new Date() }] });
    } catch (err: any) {
      if (err?.code !== 11000 || attempt === 3) throw err;
    }
  }
}

export async function listSharedCarts(userId: string) {
  const carts = await SharedCart.find({ "members.user": userId }).sort({ updatedAt: -1 }).limit(50).lean();
  return carts.map((cart) => ({
    _id: cart._id,
    name: cart.name,
    status: cart.status,
    isOwner: isOwner(cart, userId),
    memberCount: cart.members.length,
    itemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    updatedAt: cart.updatedAt,
  }));
}

export async function joinSharedCart({ code, userId }: { code: string; userId: string }) {
  const cart = await SharedCart.findOne({ code });
  if (!cart) throw new HttpError(404, "This invite link isn't valid.");
  if (cart.members.some((member) => String(member.user) === userId)) return cart;
  await ensureRoomForAnotherCart(userId);

  const joined = await SharedCart.findOneAndUpdate(
    { _id: cart._id, "members.user": { $ne: userId }, [`members.${MAX_MEMBERS - 1}`]: { $exists: false } },
    { $push: { members: { user: userId, joinedAt: new Date() } } },
    { new: true }
  );
  if (!joined) {
    const alreadyIn = await SharedCart.findOne({ _id: cart._id, "members.user": userId });
    if (alreadyIn) return alreadyIn;
    throw new HttpError(409, `This shared cart is full. Up to ${MAX_MEMBERS} people can join.`);
  }

  const names = await userNames([userId]);
  notifyUser({
    userId: String(cart.owner),
    title: "Someone joined your shared cart",
    body: `${names.get(userId) ?? "Someone"} joined ${cart.name}.`,
    data: { type: "shared-cart", sharedCartId: String(cart._id) },
  });
  return joined;
}

export async function renameSharedCart({ cartId, userId, name }: { cartId: string; userId: string; name: string }) {
  const cart = await findMemberCart(cartId, userId);
  if (!isOwner(cart, userId)) throw new HttpError(403, "Only the cart owner can rename it.");
  cart.name = name;
  return cart.save();
}

export async function deleteSharedCart({ cartId, userId }: { cartId: string; userId: string }) {
  const cart = await findMemberCart(cartId, userId);
  if (!isOwner(cart, userId)) throw new HttpError(403, "Only the cart owner can delete it.");
  const deleted = await SharedCart.deleteOne({ _id: cart._id, status: "open" });
  if (deleted.deletedCount !== 1) throw new HttpError(409, "The cart can't be deleted while everyone is paying. Cancel the payment first.");
}

// Leaving, or being removed by the owner. The person's items stay in the cart and become the owner's.
export async function removeMember({ cartId, actorId, memberId }: { cartId: string; actorId: string; memberId: string }) {
  const cart = await findMemberCart(cartId, actorId);
  const leaving = actorId === memberId;
  if (!leaving && !isOwner(cart, actorId)) throw new HttpError(403, "Only the cart owner can remove people.");
  if (isOwner(cart, memberId)) {
    throw new HttpError(400, leaving ? "You own this cart. Delete it instead of leaving." : "The owner can't be removed.");
  }
  if (cart.status !== "open") throw new HttpError(409, "People can't leave while everyone is paying. The owner can cancel the payment first.");

  const updated = await SharedCart.findOneAndUpdate(
    { _id: cart._id, status: "open", "members.user": memberId },
    { $pull: { members: { user: memberId } }, $set: { "items.$[theirs].addedBy": cart.owner } },
    { new: true, arrayFilters: [{ "theirs.addedBy": new mongoose.Types.ObjectId(memberId) }] }
  );
  if (!updated) throw new HttpError(404, "That person isn't in this cart.");
  return updated;
}

// ----- Items -----

type ItemInput = { cartId: string; userId: string; templateId: string; quantity: number; size?: string; color?: string };

export async function addSharedCartItem({ cartId, userId, templateId, quantity, size, color }: ItemInput) {
  const cart = await findMemberCart(cartId, userId);
  if (cart.status !== "open") throw lockedError();
  const product = await findBuyableProduct({ templateId, size, color });

  // Each person's additions are their own lines, so paying for your own items stays fair.
  const existing = cart.items.find(
    (item) =>
      String(item.templateId) === templateId &&
      (item.size ?? undefined) === size &&
      (item.color ?? undefined) === color &&
      String(item.addedBy) === userId
  );
  const nextQuantity = Math.min((existing?.quantity ?? 0) + quantity, MAX_ITEM_QUANTITY);
  ensureStock(product, nextQuantity);

  const updated = existing
    ? await SharedCart.findOneAndUpdate(
        { _id: cart._id, status: "open", "items._id": existing._id },
        { $set: { "items.$.quantity": nextQuantity } },
        { new: true }
      )
    : await SharedCart.findOneAndUpdate(
        { _id: cart._id, status: "open", [`items.${MAX_ITEMS - 1}`]: { $exists: false } },
        { $push: { items: { templateId: product._id, size, color, quantity, addedBy: userId } } },
        { new: true }
      );
  if (updated) return updated;

  const latest = await SharedCart.findById(cart._id).select("status").lean();
  throw latest?.status === "open" ? new HttpError(409, `A shared cart can hold up to ${MAX_ITEMS} items.`) : lockedError();
}

export async function updateSharedCartItem({ cartId, userId, itemId, quantity }: { cartId: string; userId: string; itemId: string; quantity: number }) {
  const cart = await findMemberCart(cartId, userId);
  if (cart.status !== "open") throw lockedError();
  const item = cart.items.find((line) => String(line._id) === itemId);
  if (!item) throw new HttpError(404, "Item not found in cart.");

  const product = await ProductTemplate.findById(item.templateId).select("stockQuantity").lean();
  if (product) ensureStock(product, quantity);

  const updated = await SharedCart.findOneAndUpdate(
    { _id: cart._id, status: "open", "items._id": itemId },
    { $set: { "items.$.quantity": quantity } },
    { new: true }
  );
  if (!updated) throw lockedError();
  return updated;
}

export async function removeSharedCartItem({ cartId, userId, itemId }: { cartId: string; userId: string; itemId: string }) {
  const cart = await findMemberCart(cartId, userId);
  if (cart.status !== "open") throw lockedError();
  const updated = await SharedCart.findOneAndUpdate(
    { _id: cart._id, status: "open" },
    { $pull: { items: { _id: itemId } } },
    { new: true }
  );
  if (!updated) throw lockedError();
  return updated;
}

// ----- Working out who pays what -----

type ShareDraft = { user: string; itemsKobo: number; amountKobo: number };

// Splits an amount into n parts that add up exactly; the leftover kobo go to the first people.
function splitEvenly(totalKobo: number, parts: number) {
  const base = Math.floor(totalKobo / parts);
  const leftover = totalKobo - base * parts;
  return Array.from({ length: parts }, (_, index) => base + (index < leftover ? 1 : 0));
}

export function computeShares({
  mode,
  priced,
  discountKobo,
  itemOwners,
  memberIds,
  ownerId,
  payerId,
}: {
  mode: PaymentMode;
  priced: PricedCart;
  discountKobo: number;
  itemOwners: Map<string, string>;
  memberIds: string[];
  ownerId: string;
  payerId: string;
}): ShareDraft[] {
  const itemsKobo = priced.subtotalKobo - discountKobo;
  const totalKobo = itemsKobo + priced.deliveryFeeKobo;
  if (mode === "one-payer") return [{ user: payerId, itemsKobo, amountKobo: totalKobo }];

  // The owner first, then members in the order they joined, so rounding is predictable.
  const people = [ownerId, ...memberIds.filter((id) => id !== ownerId)];
  if (mode === "split-evenly") {
    const items = splitEvenly(itemsKobo, people.length);
    const amounts = splitEvenly(totalKobo, people.length);
    return people.map((user, index) => ({ user, itemsKobo: items[index], amountKobo: amounts[index] }));
  }

  // Own items: each person pays for what they added, plus an even part of the delivery fee of each seller they bought from.
  const shares = new Map(people.map((user) => [user, { user, itemsKobo: 0, amountKobo: 0 }]));
  const buyersBySeller = new Map<string, string[]>();
  for (const line of priced.lines) {
    if (!line.available) continue;
    const addedBy = itemOwners.get(line.id);
    const buyer = addedBy && shares.has(addedBy) ? addedBy : ownerId;
    const lineKobo = line.unitPriceKobo * line.quantity;
    shares.get(buyer)!.itemsKobo += lineKobo;
    shares.get(buyer)!.amountKobo += lineKobo;

    const sellerKey = line.merchantId ?? "impressa";
    const buyers = buyersBySeller.get(sellerKey) ?? [];
    if (!buyers.includes(buyer)) buyers.push(buyer);
    buyersBySeller.set(sellerKey, buyers);
  }
  for (const seller of priced.sellers) {
    const buyers = (buyersBySeller.get(seller.merchantId ?? "impressa") ?? []).sort((a, b) => people.indexOf(a) - people.indexOf(b));
    if (buyers.length === 0) continue;
    splitEvenly(seller.deliveryFeeKobo, buyers.length).forEach((part, index) => {
      shares.get(buyers[index])!.amountKobo += part;
    });
  }
  return [...shares.values()].filter((share) => share.amountKobo > 0);
}

type SharedQuote = {
  priced: PricedCart;
  coupon: AppliedCoupon | null;
  couponError: string | null;
  discountKobo: number;
  totalKobo: number;
  shares: ShareDraft[];
  problem: string | null;
};

export async function quoteSharedCart({
  cart,
  mode,
  payerId,
  couponCode,
}: {
  cart: ISharedCart;
  mode: PaymentMode;
  payerId: string;
  couponCode?: string;
}): Promise<SharedQuote> {
  const ownerId = String(cart.owner);
  const memberIds = cart.members.map((member) => String(member.user));
  if (mode === "one-payer" && !memberIds.includes(payerId)) throw new HttpError(400, "Choose someone in this cart to pay.");

  const [priced, settings] = await Promise.all([priceItems(cart.items), getRewardSettings()]);

  let coupon: AppliedCoupon | null = null;
  let couponError: string | null = null;
  if (couponCode?.trim()) {
    if (mode !== "one-payer" || payerId !== ownerId) {
      couponError = "Coupons can only be used when the cart owner pays for everything.";
    } else if (!settings.couponsEnabled) {
      couponError = "Coupons aren't available right now.";
    } else {
      try {
        coupon = await applyCoupon({ code: couponCode, userId: ownerId, subtotalKobo: priced.subtotalKobo });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        couponError = err.message;
      }
    }
  }

  const discountKobo = coupon?.discountKobo ?? 0;
  const itemOwners = new Map(cart.items.map((item) => [String(item._id), String(item.addedBy)]));
  const shares = computeShares({ mode, priced, discountKobo, itemOwners, memberIds, ownerId, payerId });

  let problem: string | null = null;
  if (priced.lines.length === 0) problem = "The cart is empty.";
  else if (priced.hasUnavailable) problem = "Some items are no longer available. Remove them first.";
  else if (shares.some((share) => share.amountKobo < MIN_CARD_CHARGE_KOBO)) {
    problem = `Each person's share must be at least ${formatNaira(MIN_CARD_CHARGE_KOBO)}. Choose another way to pay.`;
  }

  return { priced, coupon, couponError, discountKobo, totalKobo: priced.subtotalKobo - discountKobo + priced.deliveryFeeKobo, shares, problem };
}

export async function toSharedQuoteResponse(quote: SharedQuote) {
  const names = await userNames(quote.shares.map((share) => share.user));
  return {
    subtotal: toNaira(quote.priced.subtotalKobo),
    deliveryFee: toNaira(quote.priced.deliveryFeeKobo),
    discount: toNaira(quote.discountKobo),
    coupon: quote.coupon ? { code: quote.coupon.code, description: quote.coupon.description } : null,
    couponError: quote.couponError,
    total: toNaira(quote.totalKobo),
    problem: quote.problem,
    shares: quote.shares.map((share) => ({ userId: share.user, name: names.get(share.user) ?? "Member", amount: toNaira(share.amountKobo) })),
  };
}

// ----- Checkout -----

export async function startSharedCheckout({
  cartId,
  userId,
  mode,
  payerId,
  couponCode,
  delivery,
}: {
  cartId: string;
  userId: string;
  mode: PaymentMode;
  payerId?: string;
  couponCode?: string;
  delivery: Delivery;
}) {
  const cart = await findMemberCart(cartId, userId);
  if (!isOwner(cart, userId)) throw new HttpError(403, "Only the cart owner can check out.");
  if (cart.status !== "open") throw new HttpError(409, "Everyone is already paying for this cart.");

  const quote = await quoteSharedCart({ cart, mode, payerId: mode === "one-payer" ? payerId ?? userId : userId, couponCode });
  if (quote.couponError) throw new HttpError(400, quote.couponError);
  if (quote.problem) throw new HttpError(409, quote.problem);

  // Locking only succeeds if nobody changed the cart since it was priced.
  const checkoutId = new mongoose.Types.ObjectId();
  const locked = await SharedCart.findOneAndUpdate(
    { _id: cart._id, status: "open", updatedAt: cart.updatedAt },
    { $set: { status: "collecting", checkout: checkoutId } },
    { new: true }
  );
  if (!locked) throw new HttpError(409, "The cart just changed. Check the items and try again.");

  const checkoutQuote: CheckoutQuote = {
    priced: quote.priced,
    subtotalKobo: quote.priced.subtotalKobo,
    deliveryFeeKobo: quote.priced.deliveryFeeKobo,
    discountKobo: quote.discountKobo,
    coupon: quote.coupon,
    couponError: null,
    walletBalanceKobo: 0,
    walletAppliedKobo: 0,
    totalKobo: quote.totalKobo,
    cardKobo: quote.totalKobo,
  };

  try {
    await SharedCheckout.create({
      _id: checkoutId,
      sharedCart: cart._id,
      owner: cart.owner,
      mode,
      expiresAt: new Date(Date.now() + SHARE_PAYMENT_HOURS * 60 * 60 * 1000),
      metadata: buildOrderMetadata(String(cart.owner), checkoutQuote, delivery),
      totalKobo: quote.totalKobo,
      shares: quote.shares.map((share) => ({ user: share.user, amountKobo: share.amountKobo, itemsKobo: share.itemsKobo })),
    });
  } catch (err) {
    await SharedCart.updateOne({ _id: cart._id, checkout: checkoutId }, { $set: { status: "open", checkout: null } });
    throw err;
  }

  const names = await userNames([cart.owner]);
  for (const share of quote.shares) {
    if (share.user === userId) continue;
    notifyUser({
      userId: share.user,
      title: `Pay your share of ${cart.name}`,
      body: `${names.get(String(cart.owner)) ?? "The owner"} is checking out. Pay your ${formatNaira(share.amountKobo)} within ${SHARE_PAYMENT_HOURS} hours or the order is cancelled.`,
      data: { type: "shared-cart", sharedCartId: String(cart._id) },
    });
  }
  return locked;
}

const dropPayment = (checkoutId: unknown, reference: string) =>
  SharedCheckout.updateOne({ _id: checkoutId }, { $pull: { payments: { reference, status: "pending" } } });

export async function paySharedCartShare({
  cartId,
  user,
  useWallet,
}: {
  cartId: string;
  user: { id: string; email: string };
  useWallet: boolean;
}) {
  const cart = await findMemberCart(cartId, user.id);
  const checkout = cart.checkout ? await SharedCheckout.findById(cart.checkout) : null;
  if (!checkout || checkout.status !== "collecting" || checkout.expiresAt <= new Date()) {
    throw new HttpError(409, "There's no payment in progress for this cart.");
  }
  const share = checkout.shares.find((s) => String(s.user) === user.id);
  if (!share) throw new HttpError(403, "You don't have a share to pay in this checkout.");
  if (share.status === "paid") throw new HttpError(409, "You've already paid your share.");
  if (checkout.payments.filter((p) => String(p.user) === user.id).length >= MAX_PAYMENT_ATTEMPTS) {
    throw new HttpError(429, "Too many payment attempts. Contact Impressa support if you're having trouble paying.");
  }

  const settings = await getRewardSettings();
  const balanceKobo = useWallet && settings.walletEnabled ? await getAvailableCreditKobo(user.id) : 0;
  let walletKobo = Math.min(balanceKobo, walletLimitKobo(settings, share.itemsKobo, share.amountKobo));
  const remainderKobo = share.amountKobo - walletKobo;
  if (remainderKobo > 0 && remainderKobo < MIN_CARD_CHARGE_KOBO) walletKobo = Math.max(0, share.amountKobo - MIN_CARD_CHARGE_KOBO);
  const cardKobo = share.amountKobo - walletKobo;
  const reference = `imp_${crypto.randomBytes(12).toString("hex")}`;

  const added = await SharedCheckout.updateOne(
    { _id: checkout._id, status: "collecting", shares: { $elemMatch: { user: user.id, status: "unpaid" } } },
    { $push: { payments: { reference, user: user.id, cardKobo, walletKobo, status: "pending", createdAt: new Date() } } }
  );
  if (added.modifiedCount !== 1) throw new HttpError(409, "This payment can't be made any more. Check the cart for the latest status.");

  if (walletKobo > 0) {
    try {
      await holdWalletCredit({ userId: user.id, amountKobo: walletKobo, reference });
    } catch (err) {
      await dropPayment(checkout._id, reference);
      if (err instanceof InsufficientCreditError) throw new HttpError(409, "Your wallet balance changed. Try again.");
      throw err;
    }
  }

  const amounts = { reference, walletApplied: toNaira(walletKobo) };
  if (cardKobo === 0) {
    await applySharedCartPayment({ reference, amountKobo: 0, currency: "NGN" });
    return { paid: true, amount: 0, ...amounts };
  }

  try {
    const transaction = await initializeTransaction({
      email: user.email,
      amountKobo: cardKobo,
      reference,
      metadata: {
        kind: SHARED_CART_PAYMENT,
        sharedCheckoutId: String(checkout._id),
        sharedCartId: String(cart._id),
        userId: user.id,
        totalAmount: toNaira(cardKobo),
      },
    });
    return { paid: false, authorization_url: transaction.authorizationUrl, amount: toNaira(cardKobo), ...amounts };
  } catch (err) {
    if (walletKobo > 0) await releaseHold(reference);
    await dropPayment(checkout._id, reference);
    throw err;
  }
}

type RefundReason = "not-needed" | "wallet-short" | "expired" | "cancelled";

const REFUND_MESSAGES: Record<RefundReason, string> = {
  "not-needed": "Your share was already paid, so this payment is being refunded.",
  "wallet-short": "Your wallet credit ran out before the payment finished, so it's being refunded. Please pay your share again.",
  expired: "Not everyone paid in time, so the order was cancelled and your payment is being refunded.",
  cancelled: "The owner cancelled the payment, so yours is being refunded.",
};

// Gives a payment back: the card part is refunded to the card (or to the wallet if that fails), wallet credit is returned.
async function refundPayment(
  checkout: Pick<ISharedCheckout, "_id">,
  payment: SharePayment,
  { from, walletSpent, reason }: { from: "pending" | "paid"; walletSpent: boolean; reason: RefundReason }
) {
  const claimed = await SharedCheckout.updateOne(
    { _id: checkout._id, payments: { $elemMatch: { reference: payment.reference, status: from } } },
    { $set: { "payments.$.status": "refunded" } }
  );
  if (claimed.modifiedCount !== 1) return;

  const note = `Shared cart payment ${payment.reference}: ${reason}`;
  let toWalletKobo = 0;
  if (payment.cardKobo > 0) {
    try {
      await refundTransaction({ reference: payment.reference, amountKobo: payment.cardKobo, merchantNote: note });
    } catch (err) {
      console.error(`Card refund for shared cart payment ${payment.reference} failed; refunding to wallet instead`, err);
      Sentry.captureException(err);
      toWalletKobo += payment.cardKobo;
    }
  }
  if (walletSpent) toWalletKobo += payment.walletKobo;
  else if (payment.walletKobo > 0) await releaseHold(payment.reference);

  if (toWalletKobo > 0) {
    await creditWallet({
      userId: String(payment.user),
      amountKobo: toWalletKobo,
      source: "refund",
      expiryDays: REFUND_CREDIT_DAYS,
      idempotencyKey: `shared-refund:${payment.reference}`,
      reference: payment.reference,
      note,
    });
  }

  notifyUser({
    userId: String(payment.user),
    title: "Your shared cart payment is being refunded",
    body: `${formatNaira(payment.cardKobo + payment.walletKobo)}: ${REFUND_MESSAGES[reason]}`,
    data: { type: "wallet" },
  });
}

// Records a successful payment for a share. Safe to call more than once for the same payment.
export async function applySharedCartPayment({ reference, amountKobo, currency }: { reference: string; amountKobo: number; currency: string }) {
  const checkout = await SharedCheckout.findOne({ "payments.reference": reference });
  const payment = checkout?.payments.find((p) => p.reference === reference);
  if (!checkout || !payment) {
    const message = `Shared cart payment ${reference} doesn't match any checkout`;
    console.error(message);
    Sentry.captureMessage(message, "error");
    throw new PaymentMismatchError(message);
  }
  const latest = async () => (await SharedCheckout.findById(checkout._id))!;
  if (payment.status !== "pending") return latest();

  if (currency !== "NGN" || amountKobo !== payment.cardKobo) {
    const message = `Shared cart payment ${reference} was ${amountKobo} ${currency} but ${payment.cardKobo} NGN was expected`;
    console.error(message);
    Sentry.captureMessage(message, "error");
    throw new PaymentMismatchError(message);
  }

  const shareOpen =
    checkout.status === "collecting" && checkout.shares.some((s) => String(s.user) === String(payment.user) && s.status === "unpaid");
  if (!shareOpen) {
    await refundPayment(checkout, payment, { from: "pending", walletSpent: false, reason: "not-needed" });
    return latest();
  }

  let walletSpent = false;
  if (payment.walletKobo > 0) {
    if ((await commitHold(reference)) === "committed") {
      walletSpent = true;
    } else {
      // The hold timed out before the card payment finished; take the credit now if it's still there.
      try {
        await spendFromWallet({
          userId: String(payment.user),
          amountKobo: payment.walletKobo,
          source: "checkout",
          reference,
          idempotencyKey: `late-shared:${reference}`,
        });
        walletSpent = true;
      } catch (err) {
        if (!(err instanceof InsufficientCreditError)) throw err;
        await refundPayment(checkout, payment, { from: "pending", walletSpent: false, reason: "wallet-short" });
        return latest();
      }
    }
  }

  const marked = await SharedCheckout.updateOne(
    {
      _id: checkout._id,
      status: "collecting",
      payments: { $elemMatch: { reference, status: "pending" } },
      shares: { $elemMatch: { user: payment.user, status: "unpaid" } },
    },
    {
      $set: {
        "payments.$[p].status": "paid",
        "shares.$[s].status": "paid",
        "shares.$[s].reference": reference,
        "shares.$[s].cardKobo": payment.cardKobo,
        "shares.$[s].walletKobo": payment.walletKobo,
        "shares.$[s].paidAt": new Date(),
      },
    },
    { arrayFilters: [{ "p.reference": reference }, { "s.user": payment.user }] }
  );
  if (marked.modifiedCount !== 1) {
    // The checkout ended, or another payment covered this share, while this one was processing.
    await refundPayment(checkout, payment, { from: "pending", walletSpent, reason: "not-needed" });
    return latest();
  }

  await completeSharedCheckout(checkout._id);
  return latest();
}

// Places the order once every share is paid. Safe to call more than once.
export async function completeSharedCheckout(checkoutId: unknown) {
  let checkout = await SharedCheckout.findOneAndUpdate(
    { _id: checkoutId, status: "collecting", shares: { $not: { $elemMatch: { status: { $ne: "paid" } } } } },
    { $set: { status: "completed", closedAt: new Date() } },
    { new: true }
  );
  checkout ??= await SharedCheckout.findOne({ _id: checkoutId, status: "completed" });
  if (!checkout || checkout.order) return checkout;

  const owner = await User.findById(checkout.owner).select("email").lean();
  const order = await createOrderFromSharedCheckout(checkout, owner?.email);
  await SharedCheckout.updateOne({ _id: checkout._id }, { $set: { order: order._id } });
  checkout.order = order._id as mongoose.Types.ObjectId;

  const cart = await SharedCart.findOneAndUpdate(
    { _id: checkout.sharedCart, checkout: checkout._id },
    { $set: { items: [], status: "open", checkout: null } }
  );
  if (cart) {
    for (const member of cart.members) {
      notifyUser({
        userId: String(member.user),
        title: "Your shared order is placed",
        body: `Everyone paid for ${cart.name}, so the order is on its way to the seller.`,
        data: { type: "order", orderId: String(order._id) },
      });
    }
  }
  return checkout;
}

// Ends a checkout that's still collecting, refunding everyone who paid. Returns null if it had already finished.
export async function cancelSharedCheckout(checkoutId: unknown, reason: "expired" | "cancelled") {
  const checkout = await SharedCheckout.findOneAndUpdate(
    { _id: checkoutId, status: "collecting" },
    { $set: { status: "cancelled", cancelReason: reason, closedAt: new Date() } },
    { new: true }
  );
  if (!checkout) return null;

  const cart = await SharedCart.findOneAndUpdate(
    { _id: checkout.sharedCart, checkout: checkout._id },
    { $set: { status: "open", checkout: null } },
    { new: true }
  );

  for (const payment of checkout.payments) {
    if (payment.status === "paid") await refundPayment(checkout, payment, { from: "paid", walletSpent: true, reason });
    // A pending card payment that completes later is refunded when it arrives.
    else if (payment.status === "pending" && payment.walletKobo > 0) await releaseHold(payment.reference);
  }

  if (cart && reason === "expired") {
    for (const member of cart.members) {
      notifyUser({
        userId: String(member.user),
        title: "Shared cart payment ran out of time",
        body: `Not everyone paid for ${cart.name} within ${SHARE_PAYMENT_HOURS} hours, so nothing was ordered. Anyone who paid is being refunded.`,
        data: { type: "shared-cart", sharedCartId: String(cart._id) },
      });
    }
  }
  return checkout;
}

export async function cancelSharedCartCheckout({ cartId, userId }: { cartId: string; userId: string }) {
  const cart = await findMemberCart(cartId, userId);
  if (!isOwner(cart, userId)) throw new HttpError(403, "Only the cart owner can cancel the payment.");
  if (!cart.checkout) throw new HttpError(409, "There's no payment in progress for this cart.");
  if (!(await cancelSharedCheckout(cart.checkout, "cancelled"))) throw new HttpError(409, "This payment has already finished.");
  return findMemberCart(cartId, userId);
}

// Ends checkouts past their deadline, and places orders that a restart interrupted. Safe to run more than once.
export async function expireSharedCheckouts(now = new Date()) {
  const expired = await SharedCheckout.find({ status: "collecting", expiresAt: { $lte: now } }).select("_id").limit(200).lean();
  for (const checkout of expired) await cancelSharedCheckout(checkout._id, "expired");

  const unfinished = await SharedCheckout.find({ status: "completed", order: null }).select("_id").limit(50).lean();
  for (const checkout of unfinished) await completeSharedCheckout(checkout._id);
  return expired.length;
}

// ----- Responses -----

export async function toSharedCartResponse(cart: ISharedCart, viewerId: string) {
  const [priced, names, checkout] = await Promise.all([
    priceItems(cart.items),
    userNames([...cart.members.map((member) => member.user), ...cart.items.map((item) => item.addedBy)]),
    cart.checkout ? SharedCheckout.findById(cart.checkout).lean() : Promise.resolve(null),
  ]);
  const itemOwners = new Map(cart.items.map((item) => [String(item._id), String(item.addedBy)]));
  const base = toCartResponse(priced);

  return {
    _id: cart._id,
    name: cart.name,
    code: cart.code,
    status: cart.status,
    isOwner: isOwner(cart, viewerId),
    inviteUrl: `${env.APP_URL.replace(/\/$/, "")}/shared-cart/${cart.code}`,
    members: cart.members.map((member) => ({
      userId: String(member.user),
      name: names.get(String(member.user)) ?? "Member",
      isOwner: String(member.user) === String(cart.owner),
      isYou: String(member.user) === viewerId,
    })),
    ...base,
    items: base.items.map((item) => {
      const addedBy = itemOwners.get(item.id) ?? null;
      return { ...item, addedBy: { userId: addedBy, name: (addedBy && names.get(addedBy)) || "Member" } };
    }),
    checkout: checkout
      ? {
          _id: checkout._id,
          mode: checkout.mode,
          status: checkout.status,
          expiresAt: checkout.expiresAt,
          total: toNaira(checkout.totalKobo),
          shares: checkout.shares.map((share) => ({
            userId: String(share.user),
            name: names.get(String(share.user)) ?? "Member",
            amount: toNaira(share.amountKobo),
            status: share.status,
            isYou: String(share.user) === viewerId,
          })),
          paidCount: checkout.shares.filter((share) => share.status === "paid").length,
        }
      : null,
  };
}
