import { formatJotDetail } from "../core.ts";
import type { Command } from "./types.ts";

export const jot: Command = {
	name: "jot",
	description: "dump one jot's record — /jot <id>",
	run: async (_ctx, args, d) => {
		const id = args.trim();
		if (!id) return "usage: /jot <id>";
		const j = await d.repo.getJot(id);
		return j ? formatJotDetail(j) : `no jot ${id}`;
	},
};
