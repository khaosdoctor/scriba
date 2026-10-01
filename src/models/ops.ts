import { z } from "zod";
import type { JotStatus } from "./domain.ts";

/** The fields we read from a GitHub release. */
export const ReleaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  html_url: z.string(),
  published_at: z.string(),
});
export type Release = z.infer<typeof ReleaseSchema>;

/** Jot counts over a window, broken down by kind and outcome, for the /stats command. */
export interface Stats {
  total: number;
  text: number;
  audio: number;
  image: number;
  video: number;
  done: number;
  failed: number;
  abandoned: number;
  inflight: number;
}

export type StatusCounts = Record<JotStatus, number>;

/** Which buttons a jot's status message carries. A jot that finishes gets `undo`; one that
 *  fails gets `retry` and `discard`: every failure is a decision, and both halves of it
 *  should be one tap away rather than a command you have to remember. */
export type StatusButtons = {
  retry?: boolean;
  undo?: boolean;
  discard?: boolean;
  /** Line holds a YouTube/tweet/image URL: offer to embed it, or to turn it back into a
   *  link (`embedOffer` in core.ts decides which). */
  embed?: "embed" | "plain";
};
