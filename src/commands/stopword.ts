import type { Command } from "./types.ts";

export const stopword: Command = {
	name: "stopword",
	description: "manage stopwords — /stopword add|del|list [word]",
	run: async (_ctx, args, d) => {
		const [sub, ...rest] = args.trim().split(/\s+/);
		const word = rest.join(" ");
		if (sub === "list") {
			const words = [...(await d.repo.stopwords())].sort();
			return words.length ? words.join(", ") : "(none)";
		}
		if (sub === "add") {
			if (!word) return "usage: /stopword add <word>";
			await d.repo.addStopword(word);
			return `➕ stopword "${word.toLowerCase()}"`;
		}
		if (sub === "del") {
			if (!word) return "usage: /stopword del <word>";
			const n = await d.repo.delStopword(word);
			return n
				? `➖ removed "${word.toLowerCase()}"`
				: `no stopword "${word.toLowerCase()}"`;
		}
		return "usage: /stopword add|del|list [word]";
	},
};
