import { InlineKeyboard } from "grammy";
import { distinctSurfaces } from "../core.ts";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("unreject");

/** Callback_query namespace this command owns (routed from ScribaBot.handleButton).
 *  `ur:s:<si>` opens the note menu for a surface; `ur:p:<si>:<ni>` unrejects the pair.
 *  Indices are positions in `repo.rejectionList()`, re-derived on each tap. */
export const UNREJECT_NS = "ur";

export const unreject: Command = {
	name: "unreject",
	description: "undo a link-rejection (menu, or /unreject <word> <note>)",
	run: async (ctx, args, d) => {
		const t = args.trim();
		// Direct form kept for muscle memory: note is the last token, surface the rest.
		if (t) {
			const i = t.lastIndexOf(" ");
			if (i < 0)
				return "usage: /unreject <word> <note> (or /unreject with no args for a menu)";
			const surface = t.slice(0, i);
			const note = t.slice(i + 1);
			const n = await d.repo.unreject(surface, note);
			log.info({ surface, note, removed: n }, "/unreject direct");
			return n
				? `↩️ "${surface}" may link to [[${note}]] again`
				: `no rejection for "${surface}" → [[${note}]]`;
		}

		// Interactive: step 1 — pick a rejected word.
		const list = await d.repo.rejectionList();
		if (!list.length) return "(no rejections)";
		const surfaces = distinctSurfaces(list);
		log.info({ surfaces: surfaces.length }, "/unreject menu opened");
		const kb = new InlineKeyboard();
		surfaces.forEach((s, i) => {
			kb.text(s, `${UNREJECT_NS}:s:${i}`).row();
		});
		await ctx.reply("Pick a rejected word to unreject:", { reply_markup: kb });
	},
};
