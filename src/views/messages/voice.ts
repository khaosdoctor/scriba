import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";

/** A voice note or audio file: a spoken task while task mode is open, an audio jot
 *  otherwise. */
export function voiceView({
  tasks,
  jots,
  jotController,
}: ViewDeps): Composer<Context> {
  const view = new Composer<Context>();
  view.on(["message:voice", "message:audio"], (ctx) => {
    const input = intakeInput(ctx.message)!;
    return tasks.isOpen()
      ? jots.spokenTask(ctx, input.fileId!)
      : jotController.intake(input);
  });
  return view;
}
