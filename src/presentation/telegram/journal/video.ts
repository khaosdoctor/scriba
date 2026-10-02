import type { Bot } from "grammy";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";

export function videoView(bot: Bot, { jotController }: ViewDeps): void {
  bot.on(["message:video", "message:video_note"], (ctx) =>
    jotController.intake(intakeInput(ctx.message)!),
  );
}
