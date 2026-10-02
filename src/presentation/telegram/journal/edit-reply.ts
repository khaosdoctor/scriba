import { Composer, type Context } from "grammy";
import type { EditOutcome, EditService } from "../../../services/edits.ts";

export const STILL_PROCESSING: Record<"queued" | "removal-queued", string> = {
  queued: "⏳ still processing — I'll apply that edit once it's done.",
  "removal-queued": "⏳ still processing — I'll remove it once it's done.",
};

const REPLIES: Record<EditOutcome, string | null> = {
  unmapped: "Can't find that jot to edit.",
  missing: "Jot not found.",
  ...STILL_PROCESSING,
  applied: null,
};

export function editReply(edits: EditService): Composer<Context> {
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
