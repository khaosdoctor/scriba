import { formatStatus } from "../core.ts";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("status");

export const status: Command = {
	name: "status",
	description: "health snapshot",
	run: async (_ctx, _args, d) => {
		log.info("/status command");
		return formatStatus({
			counts: await d.repo.statusCounts(),
			queueDepth: d.queue.depth,
			transcriber: d.transcriber.mode,
			links: d.links.stats(),
			version: d.version,
			sha: d.sha,
			uptimeMs: Date.now() - d.startedAt,
		});
	},
};
