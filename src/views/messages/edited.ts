import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";
import { editInput } from "../input.ts";

/** An edited message or caption replaces its jot's text. Edited text starting with `/` is a
 *  command being corrected and is left alone; a caption is never a command. */
export function editedView({ jots }: ViewDeps): Composer<Context> {
  const view = new Composer<Context>();
  view.on(["edited_message:text", "edited_message:caption"], (ctx) => {
    if (ctx.editedMessage.text?.startsWith("/")) return;
    return jots.applyMessageEdit(ctx, editInput(ctx.editedMessage).text);
  });
  return view;
}
