import { type Composer, type Context, InlineKeyboard } from "grammy";
import {
  BACKFILL_NS,
  dayLabel,
  movedKeyboard,
} from "../../../libs/backfill.ts";
import { logger } from "../../../libs/log.ts";
import { isIsoDate } from "../../../libs/time.ts";
import type {
  BackfillService,
  MoveOutcome,
} from "../../../services/backfill.ts";
import { namespace, type Tap } from "../namespace.ts";

const log = logger("backfill");

/** A failed move has no card text, so the card keeps its buttons and another tap retries. */
const REFUSALS: Record<
  Exclude<MoveOutcome, "moved">,
  { toast: string; alert?: boolean; card?: string }
> = {
  gone: { toast: "gone", card: "That jot is gone." },
  busy: {
    toast: "that jot is being processed or is already there",
    alert: true,
  },
  "no-line": {
    toast: "couldn't find the line",
    card: "⚠️ That line is gone from the note.",
  },
  failed: { toast: "couldn't move it, tap again to retry", alert: true },
};

async function settle(
  ctx: Tap,
  text: string,
  keyboard = new InlineKeyboard(),
): Promise<void> {
  await ctx
    .editMessageText(text, { reply_markup: keyboard })
    .catch((err: unknown) => log.warn({ err }, "backfill card settle failed"));
}

export function backfillView(backfill: BackfillService): Composer<Context> {
  return namespace(
    BACKFILL_NS,
    async (ctx, [action, jotId, arg], responder) => {
      log.debug({ action, jotId, arg }, "backfill button tapped");
      if (action === "n") return responder.ack();
      if (action === "k") {
        log.info({ jotId }, "backfill: kept on its own day");
        await responder.ack("kept");
        return settle(ctx, "🚫 Kept where it was.");
      }
      if (action === "c" && jotId && arg && isIsoDate(`${arg}-01`)) {
        await responder.ack();
        return ctx
          .editMessageReplyMarkup({
            reply_markup: backfill.calendar(jotId, arg),
          })
          .catch((err: unknown) => log.warn({ err }, "calendar redraw failed"));
      }
      const moveTo =
        action === "m" && arg && isIsoDate(arg) && backfill.isPast(arg);
      if (!moveTo && action !== "u") {
        log.warn({ action, jotId, arg }, "backfill tap rejected: bad payload");
        return responder.ack("bad button");
      }
      const outcome = moveTo
        ? await backfill.move(jotId, arg)
        : await backfill.undo(jotId);
      if (outcome !== "moved") {
        const { toast, alert, card } = REFUSALS[outcome];
        await responder.ack(toast, { alert });
        if (card !== undefined) await settle(ctx, card);
        return;
      }
      await responder.ack("moved");
      if (!moveTo) return settle(ctx, "↩️ Moved back to the day you wrote it.");
      return settle(
        ctx,
        `🗓 Moved to ${dayLabel(arg)}.`,
        new InlineKeyboard(movedKeyboard(jotId!).inline_keyboard),
      );
    },
  );
}
