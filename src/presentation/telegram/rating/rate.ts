import { logger } from "../../../libs/log.ts";
import { isIsoDate, plainDate } from "../../../libs/time.ts";
import type { CommandView } from "../commands.ts";

const log = logger("rating");

export const rate: CommandView = {
  command: "rate",
  description: "Rate a day 1–10 (today, or /rate YYYY-MM-DD)",
  example: "/rate 2026-01-15 → asks for that day's rating instead of today's",
  async run(ctx, { rating }) {
    const arg = ctx.match.trim();
    log.info({ arg: arg || "(today)" }, "/rate command");
    if (arg && !isIsoDate(arg)) {
      log.warn({ arg }, "/rate rejected: bad date");
      await ctx.reply("Usage: /rate or /rate YYYY-MM-DD");
      return;
    }
    await rating.prompt(arg || plainDate());
  },
};
