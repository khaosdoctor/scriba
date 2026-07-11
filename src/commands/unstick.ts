import { pluralize } from "../core.ts";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("unstick");

export const unstick: Command = {
	name: "unstick",
	description: "reset jots wedged in 'processing'",
	run: async (_ctx, _args, d) => {
		const n = await d.repo.resetProcessing();
		log.info({ count: n }, "/unstick command");
		return `🔧 unstuck ${pluralize(n, "jot")}`;
	},
};
