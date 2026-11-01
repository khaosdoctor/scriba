import { type Composer, type Context, InlineKeyboard } from "grammy";
import { EDIT_NS } from "../../../libs/jot.ts";
import { logger } from "../../../libs/log.ts";
import {
  type JotService,
  TIL_NS,
  type TilOutcome,
} from "../../../services/jots.ts";
import { namespace } from "../namespace.ts";

const log = logger("til-flow");

/** `card` is the card's final text; a failed move has none, so the card keeps its buttons
 *  and another tap is the retry (a reprocess never asks again). */
const REPLIES: Record<
  TilOutcome,
  { toast: string; alert?: boolean; card?: string }
> = {
  gone: { toast: "gone", card: "That jot is gone." },
  kept: { toast: "kept in the journal", card: "🚫 Kept in the journal." },
  failed: { toast: "couldn't move it, tap again to retry", alert: true },
  "no-line": {
    toast: "couldn't find the line",
    card: "⚠️ That line is gone from the note.",
  },
  "no-heading": {
    toast: "no TIL heading",
    card: "⚠️ That note has no TIL heading, so the line stays in the journal.",
  },
  moved: { toast: "moved to TIL", card: "💡 Moved to TIL." },
};

export function tilView(jots: JotService): Composer<Context> {
  return namespace(TIL_NS, async (ctx, [action, jotId], responder) => {
    const outcome = await jots.answerTil(jotId, action === "y");
    const { toast, alert, card } = REPLIES[outcome];
    await responder.ack(toast, { alert });
    if (card === undefined) return;
    // A moved line is the enricher's rewrite, so ✏️ Edit stays on hand to fix it.
    const keyboard =
      outcome === "moved"
        ? new InlineKeyboard().text("✏️ Edit", `${EDIT_NS}:${jotId}`)
        : new InlineKeyboard();
    await ctx
      .editMessageText(card, { reply_markup: keyboard })
      .catch((err: unknown) => log.warn({ err }, "til card settle failed"));
  });
}
