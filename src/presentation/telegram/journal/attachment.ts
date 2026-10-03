import type { Bot } from "grammy";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";

export function attachmentView(bot: Bot, { jots }: ViewDeps): void {
  bot.on(["message:photo", "message:video", "message:video_note"], (ctx) =>
    jots.intake(intakeInput(ctx.message)!),
  );
}
