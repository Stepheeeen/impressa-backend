import { z } from "zod";
import { NIGERIA_STATES } from "../constants/nigeria";

export const DeliverySchema = z.object({
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

export type Delivery = z.infer<typeof DeliverySchema>;
