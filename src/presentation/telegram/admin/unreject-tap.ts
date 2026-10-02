import { type Composer, type Context, InlineKeyboard } from "grammy";
import { logger } from "../../../libs/log.ts";
import type { AdminService } from "../../../services/admin.ts";
import { namespace } from "../namespace.ts";

const log = logger("bot");

/** `ur:s:<si>` opens the note menu for a rejected word; `ur:p:<si>:<ni>` unrejects the
 *  pair. A shifted index answers "expired" rather than undoing the wrong pair. */
export const UNREJECT_NS = "ur";

export function unrejectView(admin: AdminService): Composer<Context> {
  return namespace(UNREJECT_NS, async (ctx, [step, ...idx]) => {
    const word = await admin.rejectedWord(step, idx);
    if (!word) return ctx.answerCallbackQuery({ text: "expired" });
    const { surface } = word;

    if (step === "s") {
      log.info(
        { surface, notes: word.notes.length },
        "unreject: surface picked",
      );
      const kb = new InlineKeyboard();
      for (const [i, note] of word.notes.entries())
        kb.text(note, `${UNREJECT_NS}:p:${idx[0]}:${i}`).row();
      await ctx.answerCallbackQuery();
      return ctx.editMessageText(`Unreject "${surface}" → which note?`, {
        reply_markup: kb,
      });
    }

    if (step === "p") {
      const pair = await admin.unrejectNote(word, idx);
      if (!pair) return ctx.answerCallbackQuery({ text: "expired" });
      const { note, removed } = pair;
      await ctx.answerCallbackQuery({
        text: removed ? "unrejected" : "already gone",
      });
      return ctx.editMessageText(
        removed
          ? `↩️ "${surface}" may link to [[${note}]] again`
          : `no rejection for "${surface}" → [[${note}]]`,
      );
    }

    await ctx.answerCallbackQuery();
  });
}
