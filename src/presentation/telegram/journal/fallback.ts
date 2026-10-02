import { Composer, type Context } from "grammy";

/** Any message kind no view above claimed. */
export function fallbackView(): Composer<Context> {
  const view = new Composer<Context>();
  view.on("message", (ctx) =>
    ctx.reply("scriba handles text, voice, images, and video for now."),
  );
  return view;
}
