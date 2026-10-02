import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";
import { editInput } from "../input.ts";
import { STILL_PROCESSING } from "./edit-reply.ts";

/** An edited message or caption replaces its jot's text. Edited text starting with `/` is a
 *  command being corrected and is left alone; a caption is never a command. */
export function editedView({ edits }: ViewDeps): Composer<Context> {
  const view = new Composer<Context>();
  view.on(["edited_message:text", "edited_message:caption"], async (ctx) => {
    if (ctx.editedMessage.text?.startsWith("/")) return;
    const outcome = await edits.editByMessageEdit(editInput(ctx.editedMessage));
    if (outcome === "queued" || outcome === "removal-queued")
      return void ctx.reply(STILL_PROCESSING[outcome]);
  });
  return view;
}
