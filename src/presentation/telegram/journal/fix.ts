import { logger } from "../../../libs/log.ts";
import type { CommandView } from "../commands.ts";

const log = logger("bot");

/** /fix <id>, or /fix as a reply to a jot's message: run the transcript clean-up again
 *  over that entry and reprocess it from the fixed text. The fix is a model call, so it
 *  runs in the background and answers on its own: the update loop isn't held for it. */
export const fixCommand: CommandView = {
  command: "fix",
  description: "Clean up a jot's text again: /fix <id>, or reply /fix",
  example:
    "/fix 1a2b3c4d → cleans up that jot's text, shows you the result and reprocesses it",
  async run(ctx, { edits, jots }) {
    const typed = ctx.match.trim().toLowerCase();
    const quoted = ctx.message?.reply_to_message?.message_id;
    const id =
      typed || (quoted === undefined ? "" : await jots.idForMessage(quoted));
    if (!id) {
      log.warn({ quoted }, "fix command without a jot");
      return void ctx.reply(
        "Send /fix <id>, or reply /fix to a journal message.",
      );
    }
    log.info({ id }, "fix command");
    await ctx.reply(`🔧 Fixing ${id}…`);
    void edits.refix(id);
  },
};
