import type { Context, Filter } from "grammy";
import type { Message } from "grammy/types";
import {
  type FollowupRef,
  followupFromCode,
  type RatingController,
} from "../../controllers/rating.ts";
import type { JotHandlers } from "../index.ts";
import { entitiesToMarkdown } from "../input.ts";

/** The question and day a follow-up prompt's marker names, or null for any other text. */
export function parseFollowupRef(text: string): FollowupRef | null {
  const m = text.match(/\(fu:([a-z]):(\d{4}-\d{2}-\d{2})\)/);
  const question = followupFromCode(m?.[1]);
  return m && question ? { question, date: m[2]! } : null;
}

/** A reply to a follow-up prompt: its text, formatting kept, is filed as a jot for the
 *  prompt's day. */
export function followupReply(rating: RatingController, jots: JotHandlers) {
  return (
    ctx: Filter<Context, "message:text">,
    ref: FollowupRef,
    prompt: Message,
  ) =>
    rating.answerFollowup(
      ref,
      entitiesToMarkdown(ctx.message.text, ctx.message.entities).trim(),
      prompt.message_id,
      (date, text) => jots.intake(ctx, "text", { rawText: text, day: date }),
    );
}
