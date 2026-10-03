import type { Bot, Context } from "grammy";
import { logger } from "../../../libs/log.ts";
import type { TaskService } from "../../../services/tasks.ts";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";
import { taskMessage } from "../tasks/mode.ts";

const log = logger("bot");

async function spokenTask(
  ctx: Context,
  tasks: TaskService,
  fileId: string,
): Promise<void> {
  await ctx.react("✍").catch(() => {});
  const text = await tasks.spokenTask(fileId);
  log.info({ chars: text.length }, "task mode: voice note transcribed");
  await taskMessage(ctx, tasks, text);
}

export function voiceView(bot: Bot, { tasks, jots }: ViewDeps): void {
  bot.on(["message:voice", "message:audio"], (ctx) => {
    const input = intakeInput(ctx.message)!;
    return tasks.isOpen()
      ? spokenTask(ctx, tasks, input.fileId!)
      : jots.intake(input);
  });
}
