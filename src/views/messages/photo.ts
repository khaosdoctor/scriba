import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";

/** A photo is an attachment: saved and embedded, caption kept as the entry, never
 *  transcribed. The largest size Telegram offers is the one saved. */
export function photoView({ jots }: ViewDeps): Composer<Context> {
  const view = new Composer<Context>();
  view.on("message:photo", (ctx) =>
    jots.intakeMedia(ctx, "image", ctx.message.photo.at(-1)!.file_id),
  );
  return view;
}
