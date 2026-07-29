import { InlineKeyboard } from "grammy";
import { distinctSurfaces } from "../core.ts";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("unreject");

/** Callback_query namespace this command owns (routed from ScribaBot.handleButton).
 *  `ur:s:<si>` opens the note menu for a surface; `ur:p:<si>:<ni>` unrejects the pair.
 *  Indices are positions in `repo.rejectionList()`, re-derived on each tap. */
export const UNREJECT_NS = "ur";

// Rows in the one-shot pick keyboard. Telegram rejects an oversized reply_markup outright.
const ROWS = 30;

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
		// This one-shot keyboard has no pages to turn — /menu › 🔗 Link rules does, so the
		// long tail lives there. Cap the rows rather than sending a keyboard Telegram will
		// reject, and name the cut so the list never reads as complete when it isn't.
		const shown = surfaces.slice(0, ROWS);
		const kb = new InlineKeyboard();
		for (const [i, s] of shown.entries()) {
			kb.text(s, `${UNREJECT_NS}:s:${i}`).row();
		}
		const more = surfaces.length - shown.length;
		if (more) log.info({ more }, "/unreject menu truncated");
		await ctx.reply(
			more
				? `Pick a rejected word to unreject (${shown.length} of ${surfaces.length} — /menu › 🔗 Link rules pages through the rest):`
				: "Pick a rejected word to unreject:",
			{ reply_markup: kb },
		);
	},
};
