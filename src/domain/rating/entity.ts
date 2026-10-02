import { z } from "zod";

export const RatingSchema = z.coerce.number().int().min(1).max(10);
