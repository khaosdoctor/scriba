import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";
import { intakeInput } from "../input.ts";

/** A video keeps its caption as the embed's display text; a video note has no caption and
 *  stores no text at all. */
export function videoView({ jotController }: ViewDeps): Composer<Context> {
  const view = new Composer<Context>();
  view.on(["message:video", "message:video_note"], (ctx) =>
    jotController.intake(intakeInput(ctx.message)!),
  );
  return view;
}
