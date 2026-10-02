import type { Bot } from "grammy";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";

/** A photo is an attachment: saved and embedded, caption kept as the entry, never
 *  transcribed. The largest size Telegram offers is the one saved. */
export function photoView(bot: Bot, { jotController }: ViewDeps): void {
  bot.on("message:photo", (ctx) =>
    jotController.intake(intakeInput(ctx.message)!),
  );
}
