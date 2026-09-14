import { z } from "zod";

// Admin forms send "" for an empty date, price or limit.
export const emptyToNull = (value: unknown) => (value === "" || value === undefined ? null : value);

export const optionalDate = z.preprocess(emptyToNull, z.coerce.date({ error: "Enter a valid date." }).nullable());
