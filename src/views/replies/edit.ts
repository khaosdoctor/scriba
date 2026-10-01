import { Composer, type Context } from "grammy";
import type { EditController, EditOutcome } from "../../controllers/edits.ts";

/** The reply to an edit or delete that has to wait for the jot's line to exist. */
export const STILL_PROCESSING: Record<"queued" | "removal-queued", string> = {
  queued: "⏳ still processing — I'll apply that edit once it's done.",
  "removal-queued": "⏳ still processing — I'll remove it once it's done.",
};

/** An applied edit is reported on the jot's status message, so it gets no reply here. */
const REPLIES: Record<EditOutcome, string | null> = {
  unmapped: "Can't find that jot to edit.",
  missing: "Jot not found.",
  ...STILL_PROCESSING,
  applied: null,
};

/** A text reply to a jot's own message or its status message edits that jot's line: a
 *  literal `s/old/new/`, or a freeform instruction for the model. Every prompt reply and
 *  task mode get to claim the text first, so any other quoted message is an edit. */
export function editReply(edits: EditController): Composer<Context> {
  const view = new Composer<Context>();
  view.on("message:text", async (ctx, next) => {
    const quoted = ctx.message.reply_to_message;
    if (!quoted) return next();
    const reply =
      REPLIES[await edits.editByReply(quoted.message_id, ctx.message.text)];
    if (reply !== null) return void ctx.reply(reply);
  });
  return view;
}
