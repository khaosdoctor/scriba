import type { Bot } from "grammy";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";
import { promptReplies } from "../replies.ts";
import { taskMessage } from "../tasks/mode.ts";
import { editReply } from "./edit-reply.ts";

/** Plain text, in the order its owners claim it: a slash no command answered is dropped,
 *  command mode takes the whole stream, then the prompt replies, then task mode (replies
 *  included), then a reply edits its jot, and whatever is left is a journal intake. */
export function textView(bot: Bot, deps: ViewDeps): void {
  const { command, modes, tasks, edits, jotController } = deps;
  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return;
    if (modes.isOpen("command"))
      return command.handle(ctx.message.text, ctx.message.message_id);
    await next();
  });
  for (const reply of promptReplies(deps)) bot.use(reply);
  bot.on("message:text", async (ctx, next) => {
    if (tasks.isOpen()) return taskMessage(ctx, tasks, ctx.message.text);
    await next();
  });
  bot.use(editReply(edits));
  bot.on("message:text", (ctx) =>
    jotController.intake(intakeInput(ctx.message)!),
  );
}
