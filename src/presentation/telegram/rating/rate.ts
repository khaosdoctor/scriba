import { Composer, type Context } from "grammy";
import { logger } from "../../../libs/log.ts";
import { DATE_RE, plainDate } from "../../../libs/time.ts";
import type { CommandView } from "../commands.ts";

const log = logger("rating");

/** `/rate` asks about today, `/rate 2026-07-05` about that day. */
export const rate: CommandView = {
  command: "rate",
  description: "Rate a day 1–10 (today, or /rate YYYY-MM-DD)",
  view({ rating }) {
    const view = new Composer<Context>();
    view.command("rate", async (ctx) => {
      const arg = ctx.match.trim();
      if (arg && !DATE_RE.test(arg)) {
        log.warn({ arg }, "/rate rejected: bad date");
        await ctx.reply("Usage: /rate or /rate YYYY-MM-DD");
        return;
      }
      await rating.prompt(arg || plainDate());
    });
    return view;
  },
};
