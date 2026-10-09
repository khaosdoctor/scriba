import { logger } from "../../../libs/log.ts";
import { isIsoDate, previousDate } from "../../../libs/time.ts";
import type { CommandView } from "../commands.ts";

const log = logger("habits");

export const habitsCommand: CommandView = {
  command: "habits",
  description: "Review habits (yesterday, or /habits YYYY-MM-DD)",
  example:
    "/habits 2026-01-15 → goes through that day's habits, one question each",
  async run(ctx, { habits }) {
    const arg = ctx.match.trim();
    log.info({ arg: arg || "(yesterday)" }, "/habits command");
    if (arg && !isIsoDate(arg)) {
      log.warn({ arg }, "/habits rejected: bad date");
      await ctx.reply("Usage: /habits or /habits YYYY-MM-DD");
      return;
    }
    await habits.prompt(arg || previousDate(), true);
  },
};
