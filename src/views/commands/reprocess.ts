import { Composer, type Context } from "grammy";
import { ROOT_TEXT, rootKeyboard } from "../callbacks/reprocess.ts";
import type { CommandView } from "./index.ts";

export const reprocess: CommandView = {
  command: "reprocess",
  description: "Reprocess jots — a day, a date range, or one jot",
  view() {
    const view = new Composer<Context>();
    view.command("reprocess", (ctx) =>
      ctx.reply(ROOT_TEXT, { reply_markup: rootKeyboard() }),
    );
    return view;
  },
};
