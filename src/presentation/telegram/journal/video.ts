import type { Bot } from "grammy";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";

/** A video keeps its caption as the embed's display text; a video note has no caption and
 *  stores no text at all. */
export function videoView(bot: Bot, { jotController }: ViewDeps): void {
  bot.on(["message:video", "message:video_note"], (ctx) =>
    jotController.intake(intakeInput(ctx.message)!),
  );
}
