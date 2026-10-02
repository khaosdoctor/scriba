import { logger } from "../../../libs/log.ts";
import type { EditOutcome } from "../../../services/edits.ts";
import type { CommandView } from "../commands.ts";
import { STILL_PROCESSING } from "./edit-reply.ts";

const log = logger("bot");

/** A removed line is reported on the jot's status message, so it gets no reply here. */
const REPLIES: Record<EditOutcome, string | null> = {
  unmapped: "Can't find a jot for that message.",
  missing: "Jot not found.",
  ...STILL_PROCESSING,
  applied: null,
};

/** Reply to a jot's message with /delete to remove its journal line: the explicit
 *  counterpart to clearing the message text, since Telegram never delivers a message
 *  delete to bots. */
export const deleteCommand: CommandView = {
  command: "delete",
  description: "Reply to a journal message with /delete to remove it",
  async run(ctx, { edits }) {
    const quoted = ctx.message?.reply_to_message;
    if (!quoted) {
      log.warn("delete command without a reply target");
      return void ctx.reply(
        "Reply to a journal message with /delete to remove that line.",
      );
    }
    const reply = REPLIES[await edits.deleteByReply(quoted.message_id)];
    if (reply !== null) return void ctx.reply(reply);
  },
};
