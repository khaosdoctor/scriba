import { Composer, type Context } from "grammy";
import type { TaskController } from "../../controllers/tasks.ts";
import { logger } from "../../libs/log.ts";
import { taskMessage } from "../commands/task.ts";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";

const log = logger("bot");

/** A voice note sent while task mode is open is transcribed like any other voice jot and
 *  then read as a task: dictating a task is the point of task mode being a mode rather than
 *  a command with arguments. */
async function spokenTask(
  ctx: Context,
  tasks: TaskController,
  fileId: string,
): Promise<void> {
  await ctx.react("✍").catch(() => {});
  const text = await tasks.spokenTask(fileId);
  log.info({ chars: text.length }, "task mode: voice note transcribed");
  await taskMessage(ctx, tasks, text);
}

/** A voice note or audio file: a spoken task while task mode is open, an audio jot
 *  otherwise. */
export function voiceView({
  tasks,
  jotController,
}: ViewDeps): Composer<Context> {
  const view = new Composer<Context>();
  view.on(["message:voice", "message:audio"], (ctx) => {
    const input = intakeInput(ctx.message)!;
    return tasks.isOpen()
      ? spokenTask(ctx, tasks, input.fileId!)
      : jotController.intake(input);
  });
  return view;
}
