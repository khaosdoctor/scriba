import type { Command } from "./types.ts";

export const retry: Command = {
	name: "retry",
	description: "requeue failed jots — /retry [id|all]",
	run: async (_ctx, args, d) => {
		const arg = args.trim().toLowerCase();
		// A specific id: reset and queue it directly (mirrors the retry button).
		if (arg && arg !== "all") {
			const j = await d.repo.getJot(arg);
			if (!j) return `no jot ${arg}`;
			await d.repo.updateJot(arg, {
				status: "pending",
				attempts: 0,
				error: null,
			});
			d.queue.add(arg);
			return `🔄 retrying ${arg}`;
		}
		// No arg: all failed. `all`: failed + abandoned. Sweep picks them up once reset.
		const n = await d.repo.resetFailed(arg === "all");
		if (n) void d.processor.retrySweep();
		return `🔄 requeued ${n} jot${n === 1 ? "" : "s"}${arg === "all" ? " (incl. abandoned)" : ""}`;
	},
};
