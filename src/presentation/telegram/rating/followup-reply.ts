import type { Message } from "grammy/types";
import type { FollowupRef } from "../../../libs/followup.ts";
import type { JotService } from "../../../services/jots.ts";
import type { RatingService } from "../../../services/rating.ts";
import { entitiesToMarkdown } from "../input.ts";
import type { TextReply } from "../namespace.ts";

export function followupReply(rating: RatingService, jots: JotService) {
  return (ctx: TextReply, ref: FollowupRef, prompt: Message) =>
    rating.answerFollowup(
      ref,
      entitiesToMarkdown(ctx.message.text, ctx.message.entities).trim(),
      prompt.message_id,
      (day, rawText) =>
        jots.intake({
          kind: "text",
          messageId: ctx.message.message_id,
          sentAt: ctx.message.date * 1000,
          rawText,
          day,
        }),
    );
}
