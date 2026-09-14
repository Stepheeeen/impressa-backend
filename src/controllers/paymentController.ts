import crypto from "crypto";
import { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import { buildOrderMetadata, quoteCheckout, toQuoteResponse } from "../services/checkout";
import { createOrderFromWallet } from "../services/orders";
import { initializeTransaction } from "../services/paystack";
import { toNaira } from "../services/pricing";
import { holdWalletCredit, InsufficientCreditError, releaseHold } from "../services/wallet";
import { DeliverySchema } from "../validation/delivery";

const RewardOptionsSchema = z.object({
  couponCode: z.string().trim().max(40).optional(),
  useWallet: z.boolean().optional().default(false),
});

const CheckoutSchema = RewardOptionsSchema.extend(DeliverySchema.shape);

// POST /api/pay/quote — shows the coupon discount, wallet credit and card amount before paying.
export const getCheckoutQuote = async (req: Request, res: Response) => {
  const options = RewardOptionsSchema.parse(req.body ?? {});
  res.json(toQuoteResponse(await quoteCheckout({ userId: req.user!.id, ...options })));
};

// POST /api/pay/initialize
export const initializePayment = async (req: Request, res: Response) => {
  // Amounts, email and cart contents sent by the client are ignored; everything is priced here.
  const { couponCode, useWallet, ...delivery } = CheckoutSchema.parse(req.body ?? {});
  const user = req.user!;

  const quote = await quoteCheckout({ userId: user.id, couponCode, useWallet });
  if (quote.priced.lines.length === 0) throw new HttpError(400, "Your cart is empty.");
  if (quote.priced.hasUnavailable) {
    throw new HttpError(409, "Some items in your cart are no longer available. Remove them and try again.");
  }
  if (quote.couponError) throw new HttpError(400, quote.couponError);

  const reference = `imp_${crypto.randomBytes(12).toString("hex")}`;
  const metadata = buildOrderMetadata(user.id, quote, delivery);

  if (quote.walletAppliedKobo > 0) {
    try {
      await holdWalletCredit({ userId: user.id, amountKobo: quote.walletAppliedKobo, reference });
    } catch (err) {
      if (err instanceof InsufficientCreditError) {
        throw new HttpError(409, "Your wallet balance changed. Check your order and try again.");
      }
      throw err;
    }
  }

  const amounts = { walletApplied: toNaira(quote.walletAppliedKobo), discount: toNaira(quote.discountKobo) };

  if (quote.cardKobo === 0) {
    const order = await createOrderFromWallet({ reference, email: user.email, metadata });
    return res.json({ paid: true, orderId: order._id, reference, amount: 0, ...amounts });
  }

  let transaction;
  try {
    transaction = await initializeTransaction({ email: user.email, amountKobo: quote.cardKobo, metadata, reference });
  } catch (err) {
    if (quote.walletAppliedKobo > 0) await releaseHold(reference);
    throw err;
  }

  res.json({
    paid: false,
    authorization_url: transaction.authorizationUrl,
    reference: transaction.reference,
    amount: toNaira(quote.cardKobo),
    ...amounts,
  });
};
