import { formatStats } from "../core.ts";
import { logger } from "../log.ts";
import { startOfToday } from "../time.ts";
import type { Command } from "./types.ts";

const log = logger("stats");
const DAY = 86_400_000;

export const stats: Command = {
	name: "stats",
	description: "jot counts — /stats [today|week|all]",
	run: async (_ctx, args, d) => {
		const range = args.trim().toLowerCase() || "today";
		if (range !== "all" && range !== "week" && range !== "today") {
			log.warn({ range }, "/stats rejected: bad range");
			return "usage: /stats [today|week|all]";
		}
		log.info({ range }, "/stats command");
		const now = Date.now();
		if (range === "all")
			return formatStats("all time", await d.repo.windowStats(0, now + 1000));
		if (range === "week")
			return formatStats(
				"last 7 days",
				await d.repo.windowStats(now - 7 * DAY, now + 1000),
			);
		return formatStats(
			"today",
			await d.repo.windowStats(startOfToday(), now + 1000),
		);
	},
};
