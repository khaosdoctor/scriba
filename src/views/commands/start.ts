import { Composer, type Context } from "grammy";
import type { CommandView } from "./index.ts";

export const start: CommandView = {
  command: "start",
  description: "What scriba does",
  view() {
    const view = new Composer<Context>();
    view.command("start", (ctx) =>
      ctx.reply(
        "scriba ready. Send text or a voice note to journal. /help for admin commands.",
      ),
    );
    return view;
  },
};
