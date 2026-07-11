import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("rejections");

export const rejections: Command = {
	name: "rejections",
	description: "list learned link-rejections",
	run: async (_ctx, _args, d) => {
		const list = await d.repo.rejectionList();
		log.info({ count: list.length }, "/rejections command");
		if (!list.length) return "(no rejections)";
		return list.map((r) => `"${r.surface}" ✗ [[${r.note}]]`).join("\n");
	},
};
