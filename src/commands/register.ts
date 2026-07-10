import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("register");

/** The opposite of a rejection: a hand-curated surface->note pair the enricher must
 *  always link, with no contextual judgment (see `forcedCandidates` in core.ts). */
export const register: Command = {
	name: "register",
	description: "force a wikilink — /register add|del|list <word> <note>",
	run: async (_ctx, args, d) => {
		const t = args.trim();
		const [sub, ...rest] = t.split(/\s+/);

		if (sub === "list") {
			const list = await d.repo.registeredLinks();
			log.info({ count: list.length }, "/register list");
			if (!list.length) return "(none)";
			return list.map((r) => `"${r.surface}" → [[${r.note}]]`).join("\n");
		}

		// Direct form for add/del: note is the last token, surface the rest (mirrors /unreject).
		const body = rest.join(" ");
		const i = body.lastIndexOf(" ");
		if (sub === "add") {
			if (i < 0) return "usage: /register add <word> <note>";
			const surface = body.slice(0, i);
			const note = body.slice(i + 1);
			await d.repo.addRegisteredLink(surface, note);
			log.info({ surface, note }, "/register add");
			return `🔗 "${surface.toLowerCase()}" always links to [[${note}]]`;
		}
		if (sub === "del") {
			if (i < 0) return "usage: /register del <word> <note>";
			const surface = body.slice(0, i);
			const note = body.slice(i + 1);
			const n = await d.repo.delRegisteredLink(surface, note);
			log.info({ surface, note, removed: n }, "/register del");
			return n
				? `➖ removed "${surface.toLowerCase()}" → [[${note}]]`
				: `no registration for "${surface.toLowerCase()}" → [[${note}]]`;
		}
		return "usage: /register add|del|list [word] [note]";
	},
};
