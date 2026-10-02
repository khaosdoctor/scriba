import type { Bot } from "grammy";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";

export function photoView(bot: Bot, { jotController }: ViewDeps): void {
  bot.on("message:photo", (ctx) =>
    jotController.intake(intakeInput(ctx.message)!),
  );
}
