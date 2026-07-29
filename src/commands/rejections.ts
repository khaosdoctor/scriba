import { formatListPage } from "../core.ts";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("rejections");

// Pairs per page. One line each, so 40 lines is comfortably under Telegram's 4096-character
// message cap even with long note titles.
const PAGE = 40;

export const rejections: Command = {
	name: "rejections",
	description: "list learned link-rejections — /rejections [page]",
	run: async (_ctx, args, d) => {
		const list = await d.repo.rejectionList();
		// 1-based on the wire (that's what the footer tells the user to type), 0-based in.
		const page = Math.max(1, Number(args.trim()) || 1) - 1;
		log.info({ count: list.length, page }, "/rejections command");
		if (!list.length) return "(no rejections)";
		const lines = list.map((r) => `"${r.surface}" ✗ [[${r.note}]]`);
		return formatListPage(lines, page, PAGE, "/rejections");
	},
};
