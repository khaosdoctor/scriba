import type { Command } from "./types.ts";
import { formatStats } from "../core.ts";

const DAY = 86_400_000;

export const stats: Command = {
  name: "stats",
  description: "jot counts — /stats [today|week|all]",
  run: async (_ctx, args, d) => {
    const range = args.trim().toLowerCase() || "today";
    const now = Date.now();
    if (range === "all") return formatStats("all time", await d.repo.windowStats(0, now + 1000));
    if (range === "week") return formatStats("last 7 days", await d.repo.windowStats(now - 7 * DAY, now + 1000));
    if (range === "today") {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return formatStats("today", await d.repo.windowStats(start.getTime(), now + 1000));
    }
    return "usage: /stats [today|week|all]";
  },
};
