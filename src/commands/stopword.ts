import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("stopword");

export const stopword: Command = {
	name: "stopword",
	description: "manage stopwords — /stopword add|del|list [word]",
	run: async (_ctx, args, d) => {
		const [sub, ...rest] = args.trim().split(/\s+/);
		const word = rest.join(" ");
		if (sub === "list") {
			const words = [...(await d.repo.stopwords())].sort();
			log.info({ count: words.length }, "/stopword list");
			return words.length ? words.join(", ") : "(none)";
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
