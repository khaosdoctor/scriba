import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("flush");

export const flush: Command = {
	name: "flush",
	description: "drain the flush queue now",
	run: async (_ctx, _args, d) => {
		const n = d.queue.depth;
		log.info({ depth: n }, "/flush command");
		await d.queue.flush();
		return `⚡ flushed (${n} queued)`;
	},
};
