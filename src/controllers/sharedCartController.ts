import { Request, Response } from "express";
import { z } from "zod";
import { PAYMENT_MODES } from "../models/SharedCheckout";
import { quantityField } from "../services/cartItems";
import * as shared from "../services/sharedCarts";
import { DeliverySchema } from "../validation/delivery";

const objectId = (message: string) => z.string({ error: message }).regex(/^[a-f0-9]{24}$/i, message);

const NameSchema = z.object({
  name: z.string({ error: "Give the cart a name." }).trim().min(1, "Give the cart a name.").max(60, "Keep the name under 60 characters."),
});

const JoinSchema = z.object({
  code: z.string({ error: "This invite link isn't valid." }).trim().regex(/^[A-Za-z0-9_-]{6,20}$/, "This invite link isn't valid."),
});

const AddItemSchema = z.object({
  templateId: objectId("Choose a product to add."),
  quantity: quantityField.default(1),
  size: z.string().trim().max(20).nullish(),
  color: z.string().trim().max(40).nullish(),
});

const QuantitySchema = z.object({ quantity: quantityField });

const PaymentChoiceSchema = z.object({
  mode: z.enum(PAYMENT_MODES, { error: "Choose how the cart will be paid for." }),
  // Who pays when one person pays for everything; defaults to the owner.
  payerId: objectId("Choose someone in this cart to pay.").optional(),
  couponCode: z.string().trim().max(40).optional(),
});

const CheckoutSchema = PaymentChoiceSchema.extend(DeliverySchema.shape);

const PaySchema = z.object({ useWallet: z.boolean().optional().default(false) });

const respond = async (res: Response, req: Request, cart: Parameters<typeof shared.toSharedCartResponse>[0], status = 200) =>
  res.status(status).json(await shared.toSharedCartResponse(cart, req.user!.id));

// POST /api/shared-carts
export const createSharedCart = async (req: Request, res: Response) => {
  const { name } = NameSchema.parse(req.body ?? {});
  await respond(res, req, await shared.createSharedCart({ userId: req.user!.id, name }), 201);
};

// GET /api/shared-carts
export const listSharedCarts = async (req: Request, res: Response) => {
  res.json(await shared.listSharedCarts(req.user!.id));
};

// POST /api/shared-carts/join
export const joinSharedCart = async (req: Request, res: Response) => {
  const { code } = JoinSchema.parse(req.body ?? {});
  await respond(res, req, await shared.joinSharedCart({ code, userId: req.user!.id }));
};

// GET /api/shared-carts/:id
export const getSharedCart = async (req: Request, res: Response) => {
  await respond(res, req, await shared.findMemberCart(req.params.id, req.user!.id));
};

// PATCH /api/shared-carts/:id
export const renameSharedCart = async (req: Request, res: Response) => {
  const { name } = NameSchema.parse(req.body ?? {});
  await respond(res, req, await shared.renameSharedCart({ cartId: req.params.id, userId: req.user!.id, name }));
};

// DELETE /api/shared-carts/:id
export const deleteSharedCart = async (req: Request, res: Response) => {
  await shared.deleteSharedCart({ cartId: req.params.id, userId: req.user!.id });
  res.json({ message: "Shared cart deleted" });
};

// POST /api/shared-carts/:id/leave
export const leaveSharedCart = async (req: Request, res: Response) => {
  await shared.removeMember({ cartId: req.params.id, actorId: req.user!.id, memberId: req.user!.id });
  res.json({ message: "You left the shared cart" });
};

// DELETE /api/shared-carts/:id/members/:userId
export const removeSharedCartMember = async (req: Request, res: Response) => {
  await respond(res, req, await shared.removeMember({ cartId: req.params.id, actorId: req.user!.id, memberId: req.params.userId }));
};

// POST /api/shared-carts/:id/items
export const addSharedCartItem = async (req: Request, res: Response) => {
  const input = AddItemSchema.parse(req.body ?? {});
  const cart = await shared.addSharedCartItem({
    cartId: req.params.id,
    userId: req.user!.id,
    templateId: input.templateId,
    quantity: input.quantity,
    size: input.size || undefined,
    color: input.color || undefined,
  });
  await respond(res, req, cart);
};

// PATCH /api/shared-carts/:id/items/:itemId
export const updateSharedCartItem = async (req: Request, res: Response) => {
  const { quantity } = QuantitySchema.parse(req.body ?? {});
  await respond(res, req, await shared.updateSharedCartItem({ cartId: req.params.id, userId: req.user!.id, itemId: req.params.itemId, quantity }));
};

// DELETE /api/shared-carts/:id/items/:itemId
export const removeSharedCartItem = async (req: Request, res: Response) => {
  await respond(res, req, await shared.removeSharedCartItem({ cartId: req.params.id, userId: req.user!.id, itemId: req.params.itemId }));
};

// POST /api/shared-carts/:id/quote — what each person would pay with a payment option.
export const quoteSharedCart = async (req: Request, res: Response) => {
  const { mode, payerId, couponCode } = PaymentChoiceSchema.parse(req.body ?? {});
  const cart = await shared.findMemberCart(req.params.id, req.user!.id);
  const quote = await shared.quoteSharedCart({ cart, mode, payerId: payerId ?? String(cart.owner), couponCode });
  res.json(await shared.toSharedQuoteResponse(quote));
};

// POST /api/shared-carts/:id/checkout
export const startSharedCheckout = async (req: Request, res: Response) => {
  const { mode, payerId, couponCode, ...delivery } = CheckoutSchema.parse(req.body ?? {});
  const cart = await shared.startSharedCheckout({ cartId: req.params.id, userId: req.user!.id, mode, payerId, couponCode, delivery });
  await respond(res, req, cart, 201);
};

// POST /api/shared-carts/:id/checkout/pay
export const paySharedCartShare = async (req: Request, res: Response) => {
  const { useWallet } = PaySchema.parse(req.body ?? {});
  res.json(await shared.paySharedCartShare({ cartId: req.params.id, user: { id: req.user!.id, email: req.user!.email }, useWallet }));
};

// POST /api/shared-carts/:id/checkout/cancel
export const cancelSharedCheckout = async (req: Request, res: Response) => {
  await respond(res, req, await shared.cancelSharedCartCheckout({ cartId: req.params.id, userId: req.user!.id }));
};
