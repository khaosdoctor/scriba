import { formatJotDetail } from "../core.ts";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("jot");

export const jot: Command = {
	name: "jot",
	description: "dump one jot's record — /jot <id>",
	run: async (_ctx, args, d) => {
		const id = args.trim();
		if (!id) {
			log.warn("/jot rejected: no id given");
			return "usage: /jot <id>";
		}
		const j = await d.repo.getJot(id);
		if (!j) {
			log.warn({ id }, "/jot: no such jot");
			return `no jot ${id}`;
		}
		log.info({ id }, "/jot command");
		return formatJotDetail(j);
	},
};
