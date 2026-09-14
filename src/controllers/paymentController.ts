import { Request, Response } from "express";
import { z } from "zod";
import { NIGERIA_STATES } from "../constants/nigeria";
import { HttpError } from "../middleware/errorHandler";
import { initializeTransaction } from "../services/paystack";
import { DELIVERY_FEE_KOBO, priceCart, toNaira } from "../services/pricing";

const CheckoutSchema = z.object({
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

// POST /api/pay/initialize
export const initializePayment = async (req: Request, res: Response) => {
  // Only delivery details are read from the body. Amount, email and cart contents sent by the client are ignored.
  const delivery = CheckoutSchema.parse(req.body ?? {});
  const user = req.user!;

  const priced = await priceCart(user.id);
  if (priced.lines.length === 0) throw new HttpError(400, "Your cart is empty.");
  if (priced.hasUnavailable) {
    throw new HttpError(409, "Some items in your cart are no longer available. Remove them and try again.");
  }

  const totalKobo = priced.subtotalKobo + DELIVERY_FEE_KOBO;

  const transaction = await initializeTransaction({
    email: user.email,
    amountKobo: totalKobo,
    metadata: {
      userId: user.id,
      cart: priced.lines.map((line) => ({
        templateId: line.templateId,
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
      itemType: priced.lines[0].title,
      quantity: priced.itemCount,
      subtotal: toNaira(priced.subtotalKobo),
      deliveryFee: toNaira(DELIVERY_FEE_KOBO),
      totalAmount: toNaira(totalKobo),
    },
  });

  res.json({
    authorization_url: transaction.authorizationUrl,
    reference: transaction.reference,
    amount: toNaira(totalKobo),
  });
};
