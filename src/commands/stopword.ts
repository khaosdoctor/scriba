import { formatListPage } from "../core.ts";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("stopword");

// Words per /stopword list page. Comma-joined and mostly short, so a page of 60 stays well
// inside Telegram's 4096-character message cap even for long stopwords.
const PAGE = 60;

export const stopword: Command = {
	name: "stopword",
	description: "manage stopwords — /stopword add|del|list [word|page]",
	run: async (_ctx, args, d) => {
		const [sub, ...rest] = args.trim().split(/\s+/);
		const word = rest.join(" ");
		if (sub === "list") {
			const words = [...(await d.repo.stopwords())].sort();
			// 1-based on the wire (that's what the footer tells the user to type), 0-based in.
			const page = Math.max(1, Number(rest[0]) || 1) - 1;
			log.info({ count: words.length, page }, "/stopword list");
			if (!words.length) return "(none)";
			return formatListPage(words, page, PAGE, "/stopword list", ", ");
		}
		if (sub === "add") {
			if (!word) {
				log.warn("/stopword add rejected: no word given");
				return "usage: /stopword add <word>";
			}
			await d.repo.addStopword(word);
			log.info({ word }, "/stopword add");
			return `➕ stopword "${word.toLowerCase()}"`;
		}
		if (sub === "del") {
			if (!word) {
				log.warn("/stopword del rejected: no word given");
				return "usage: /stopword del <word>";
			}
			const n = await d.repo.delStopword(word);
			log.info({ word, removed: n }, "/stopword del");
			return n
				? `➖ removed "${word.toLowerCase()}"`
				: `no stopword "${word.toLowerCase()}"`;
		}
		log.warn({ sub }, "/stopword rejected: bad subcommand");
		return "usage: /stopword add|del|list [word]";
	},
};
