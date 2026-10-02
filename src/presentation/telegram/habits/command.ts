import { logger } from "../../../libs/log.ts";
import { DATE_RE, previousDate } from "../../../libs/time.ts";
import type { CommandView } from "../commands.ts";

const log = logger("habits");

export const habitsCommand: CommandView = {
  command: "habits",
  description: "Review habits (yesterday, or /habits YYYY-MM-DD)",
  async run(ctx, { habits }) {
    const arg = ctx.match.trim();
    log.info({ arg: arg || "(yesterday)" }, "/habits command");
    if (arg && !DATE_RE.test(arg)) {
      log.warn({ arg }, "/habits rejected: bad date");
      await ctx.reply("Usage: /habits or /habits YYYY-MM-DD");
      return;
    }
    await habits.prompt(arg || previousDate(), true);
  },
};
