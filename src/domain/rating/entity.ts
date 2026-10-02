import { z } from "zod";

/** A day rating: a whole number from 1 to 10, from a button's callback text. */
export const RatingSchema = z.coerce.number().int().min(1).max(10);
