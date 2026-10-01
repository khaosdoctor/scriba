import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";

/** A video keeps its caption as the embed's display text; a video note has no caption and
 *  stores no text at all. */
export function videoView({ jots }: ViewDeps): Composer<Context> {
  const view = new Composer<Context>();
  view.on("message:video", (ctx) =>
    jots.intakeMedia(ctx, "video", ctx.message.video.file_id),
  );
  view.on("message:video_note", (ctx) =>
    jots.intake(ctx, "video", { fileId: ctx.message.video_note.file_id }),
  );
  return view;
}
