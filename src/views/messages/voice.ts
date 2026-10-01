import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";

/** A voice note or audio file: a spoken task while task mode is open, an audio jot
 *  otherwise. */
export function voiceView({ tasks, jots }: ViewDeps): Composer<Context> {
  const spoken = (ctx: Context, fileId: string) =>
    tasks.isOpen()
      ? jots.spokenTask(ctx, fileId)
      : jots.intake(ctx, "audio", { fileId });
  const view = new Composer<Context>();
  view.on("message:voice", (ctx) => spoken(ctx, ctx.message.voice.file_id));
  view.on("message:audio", (ctx) => spoken(ctx, ctx.message.audio.file_id));
  return view;
}
