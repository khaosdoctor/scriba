import { pluralize } from "../core.ts";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("retry");

export const retry: Command = {
	name: "retry",
	description: "requeue failed jots — /retry [id|all]",
	run: async (_ctx, args, d) => {
		const arg = args.trim().toLowerCase();
		// A specific id: reset and queue it directly (mirrors the retry button).
		if (arg && arg !== "all") {
			const j = await d.repo.getJot(arg);
			if (!j) {
				log.warn({ id: arg }, "/retry: no such jot");
				return `no jot ${arg}`;
			}
			await d.repo.resetForRetry(arg);
			d.queue.add(arg);
			log.info({ id: arg }, "/retry: single jot requeued");
			return `🔄 retrying ${arg}`;
		}
		// No arg: all failed. `all`: failed + abandoned. Sweep picks them up once reset.
		const n = await d.repo.resetFailed(arg === "all");
		if (n) void d.processor.retrySweep();
		log.info({ count: n, all: arg === "all" }, "/retry command");
		return `🔄 requeued ${pluralize(n, "jot")}${arg === "all" ? " (incl. abandoned)" : ""}`;
	},
};
