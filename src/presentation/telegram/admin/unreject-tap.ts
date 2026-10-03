import { type Composer, type Context, InlineKeyboard } from "grammy";
import { logger } from "../../../libs/log.ts";
import type { AdminService } from "../../../services/admin.ts";
import { namespace } from "../namespace.ts";

const log = logger("bot");

export const UNREJECT_NS = "ur";

export function unrejectView(admin: AdminService): Composer<Context> {
  return namespace(UNREJECT_NS, async (ctx, [step, ...idx], responder) => {
    const word = await admin.rejectedWord(step, idx);
    if (!word) return responder.ack("expired");
    const { surface } = word;

    if (step === "s") {
      log.info(
        { surface, notes: word.notes.length },
        "unreject: surface picked",
      );
      const kb = new InlineKeyboard();
      for (const [index, note] of word.notes.entries())
        kb.text(note, `${UNREJECT_NS}:p:${idx[0]}:${index}`).row();
      await responder.ack();
      return ctx.editMessageText(`Unreject "${surface}" → which note?`, {
        reply_markup: kb,
      });
    }

    if (step === "p") {
      const pair = await admin.unrejectNote(word, idx);
      if (!pair) return responder.ack("expired");
      const { note, removed } = pair;
      await responder.ack(removed ? "unrejected" : "already gone");
      return ctx.editMessageText(
        removed
          ? `↩️ "${surface}" may link to [[${note}]] again`
          : `no rejection for "${surface}" → [[${note}]]`,
      );
    }

    await responder.ack();
  });
}
