import { Composer, type Context } from "grammy";
import { taskMessage } from "../commands/task.ts";
import type { ViewDeps } from "../index.ts";
import { entitiesToMarkdown } from "../input.ts";
import { promptReplies } from "../replies/index.ts";

/** Plain text, in the order its owners claim it: a slash no command answered is dropped,
 *  command mode takes the whole stream, then the prompt replies, then task mode (replies
 *  included), then a reply edits its jot, and whatever is left is a journal intake. */
export function textView(deps: ViewDeps): Composer<Context> {
  const { command, tasks, jots } = deps;
  const view = new Composer<Context>();
  view.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return;
    if (command.isOpen()) return command.handle(ctx, ctx.message.text);
    await next();
  });
  for (const reply of promptReplies(deps)) view.use(reply);
  view.on("message:text", async (ctx, next) => {
    if (tasks.isOpen()) return taskMessage(ctx, tasks, ctx.message.text);
    await next();
  });
  view.on("message:text", async (ctx, next) => {
    if (ctx.message.reply_to_message) return jots.handleEdit(ctx);
    await next();
  });
  view.on("message:text", (ctx) =>
    jots.intake(ctx, "text", {
      rawText: entitiesToMarkdown(ctx.message.text, ctx.message.entities),
    }),
  );
  return view;
}
