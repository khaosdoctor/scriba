import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("sweep");

export const sweep: Command = {
	name: "sweep",
	description: "run the retry sweep now",
	run: async (_ctx, _args, d) => {
		log.info("/sweep command");
		await d.processor.retrySweep();
		return "🧹 sweep done";
	},
};
