import type { Command } from "./types.ts";

export const flush: Command = {
	name: "flush",
	description: "drain the flush queue now",
	run: async (_ctx, _args, d) => {
		const n = d.queue.depth;
		await d.queue.flush();
		return `⚡ flushed (${n} queued)`;
	},
};
