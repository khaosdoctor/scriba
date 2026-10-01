import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";

/** A photo is an attachment: saved and embedded, caption kept as the entry, never
 *  transcribed. The largest size Telegram offers is the one saved. */
export function photoView({ jotController }: ViewDeps): Composer<Context> {
  const view = new Composer<Context>();
  view.on("message:photo", (ctx) =>
    jotController.intake(intakeInput(ctx.message)!),
  );
  return view;
}
