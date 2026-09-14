import crypto from "crypto";
import { Request, Response } from "express";
import { z } from "zod";
import { NIGERIA_STATES } from "../constants/nigeria";
import { HttpError } from "../middleware/errorHandler";
import { CheckoutQuote, quoteCheckout, toQuoteResponse } from "../services/checkout";
import { createOrderFromWallet } from "../services/orders";
import { initializeTransaction } from "../services/paystack";
import { toNaira } from "../services/pricing";
import { holdWalletCredit, InsufficientCreditError, releaseHold } from "../services/wallet";

const RewardOptionsSchema = z.object({
  couponCode: z.string().trim().max(40).optional(),
  useWallet: z.boolean().optional().default(false),
});

const CheckoutSchema = RewardOptionsSchema.extend({
  state: z.enum(NIGERIA_STATES, { error: "Choose a delivery state." }),
  address: z
    .string({ error: "Enter a delivery address." })
    .trim()
    .min(5, "Enter your full delivery address.")
    .max(300, "Delivery address is too long."),
  phone: z
    .string({ error: "Enter a phone number." })
    .trim()
    .regex(/^\+?[0-9][0-9\s-]{9,15}$/, "Enter a valid phone number."),
});

type Delivery = Pick<z.infer<typeof CheckoutSchema>, "state" | "address" | "phone">;

// Everything the order is built from once payment succeeds. totalAmount is what the card is charged.
function orderMetadata(userId: string, quote: CheckoutQuote, delivery: Delivery) {
  const { lines, itemCount, sellers } = quote.priced;
  return {
    userId,
    cart: lines.map((line) => ({
      templateId: line.templateId,
      merchantId: line.merchantId,
      title: line.title,
      quantity: line.quantity,
      unitPrice: toNaira(line.unitPriceKobo),
      itemTotal: toNaira(line.unitPriceKobo * line.quantity),
      imageUrl: line.imageUrl,
      options: { size: line.size, color: line.color },
    })),
    phone: delivery.phone,
    country: "Nigeria",
    state: delivery.state,
    address: delivery.address,
    itemType: lines[0].title,
    quantity: itemCount,
    subtotal: toNaira(quote.subtotalKobo),
    deliveryFee: toNaira(quote.deliveryFeeKobo),
    discount: toNaira(quote.discountKobo),
    couponCode: quote.coupon?.code ?? null,
    walletApplied: toNaira(quote.walletAppliedKobo),
    orderTotal: toNaira(quote.totalKobo),
    totalAmount: toNaira(quote.cardKobo),
    // Each seller becomes a fulfilment with its own delivery fee once payment succeeds.
    sellers: sellers.map((seller) => ({
      merchantId: seller.merchantId,
      name: seller.name,
      deliveryFee: toNaira(seller.deliveryFeeKobo),
    })),
  };
}

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
  const metadata = orderMetadata(user.id, quote, delivery);

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
