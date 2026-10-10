import type { Composer, Context } from "grammy";
import type { Message } from "grammy/types";
import { EDIT_NS } from "../../../libs/jot.ts";
import { logger } from "../../../libs/log.ts";
import type { EditService } from "../../../services/edits.ts";
import { entitiesToMarkdown } from "../input.ts";
import { namespace, type TextReply } from "../namespace.ts";

const log = logger("bot");

const TAP_TOASTS = {
  gone: "gone",
  busy: "still processing",
  "no-line": "line not found",
  "too-long": "too long to edit here — edit it in Obsidian",
} as const;

const REPLY_TEXTS = {
  gone: "That jot is gone, nothing to edit.",
  busy: "⏳ still processing — reply to the prompt again once it's done.",
} as const;

/** ✏️ Edit on a finished jot's status message: ask for the new text. */
export function editView(edits: EditService): Composer<Context> {
  return namespace(EDIT_NS, async (ctx, [jotId], responder) => {
    log.info({ jotId }, "edit tapped");
    const outcome = await edits.askEdit(
      jotId,
      ctx.callbackQuery.message?.message_id,
    );
    if (outcome === "asked") return responder.ack();
    await responder.ack(TAP_TOASTS[outcome], { alert: outcome === "too-long" });
  });
}

/** The answer to an ✏️ Edit prompt, routed by the marker in the prompt's text. */
export function editAnswerReply(edits: EditService) {
  return async (ctx: TextReply, jotId: string, prompt: Message) => {
    const text = entitiesToMarkdown(
      ctx.message.text,
      ctx.message.entities,
    ).trim();
    const outcome = await edits.answerEdit(jotId, text, prompt.message_id);
    // A missing line is already said on the jot's status message.
    if (outcome === "gone" || outcome === "busy")
      await ctx.reply(REPLY_TEXTS[outcome]);
  };
}
