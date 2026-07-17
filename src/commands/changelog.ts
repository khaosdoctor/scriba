import { formatReleaseList, formatReleaseNote } from "../core.ts";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("changelog");

export const changelog: Command = {
	name: "changelog",
	description: "what's new — /changelog [version|N]",
	run: async (_ctx, args, d) => {
		const arg = args.trim();

		if (/^\d+$/.test(arg)) {
			const n = Math.min(20, Math.max(1, Number(arg)));
			log.info({ n }, "/changelog: listing recent releases");
			const notes = await d.github.recent(n);
			if (!notes.length) {
				log.warn("/changelog: recent releases lookup failed");
				return "⚠️ couldn't reach GitHub for release history";
			}
			return formatReleaseList(notes);
		}

		if (arg) {
			log.info({ version: arg }, "/changelog: looking up version");
			const note = await d.github.byVersion(arg);
			if (!note) {
				log.warn({ version: arg }, "/changelog: version not found");
				return `no release found for ${arg}`;
			}
			return formatReleaseNote(note);
		}

		log.info("/changelog: latest release");
		const note = await d.github.latest();
		if (!note) {
			log.warn("/changelog: latest release lookup failed");
			return "⚠️ couldn't reach GitHub for the latest release";
		}
		return formatReleaseNote(note);
	},
};
