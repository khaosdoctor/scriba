import { z } from "zod";

export const DetectedTaskSchema = z.object({
  description: z.string(),
  start: z.string().optional(),
  due: z.string().optional(),
  type: z.string().optional(),
});
export type DetectedTask = z.infer<typeof DetectedTaskSchema>;
