import { formatStatus } from "../core.ts";
import type { Command } from "./types.ts";

export const status: Command = {
	name: "status",
	description: "health snapshot",
	run: async (_ctx, _args, d) =>
		formatStatus({
			counts: await d.repo.statusCounts(),
			queueDepth: d.queue.depth,
			transcriber: d.transcriber.mode,
			links: d.links.stats(),
			version: d.version,
			sha: d.sha,
			uptimeMs: Date.now() - d.startedAt,
		}),
};
