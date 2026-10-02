import { Composer, type Context } from "grammy";
import { logger } from "../../../libs/log.ts";
import { DATE_RE, previousDate } from "../../../libs/time.ts";
import type { CommandView } from "../commands.ts";

const log = logger("habits");

/** `/habits` reviews yesterday, `/habits 2026-07-05` that day. */
export const habitsCommand: CommandView = {
  command: "habits",
  description: "Review habits (yesterday, or /habits YYYY-MM-DD)",
  view({ habits }) {
    const view = new Composer<Context>();
    view.command("habits", async (ctx) => {
      const arg = ctx.match.trim();
      if (arg && !DATE_RE.test(arg)) {
        log.warn({ arg }, "/habits rejected: bad date");
        await ctx.reply("Usage: /habits or /habits YYYY-MM-DD");
        return;
      }
      await habits.prompt(arg || previousDate(), true);
    });
    return view;
  },
};
