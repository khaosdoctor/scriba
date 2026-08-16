import { InlineKeyboard } from "grammy";
import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("failed");

export const failed: Command = {
	name: "failed",
	description: "recent failed/abandoned jots, each with retry + delete buttons",
	run: async (ctx, _args, d) => {
		const jots = await d.repo.failedJots(10);
		log.info({ count: jots.length }, "/failed command");
		if (!jots.length) return "✅ nothing failed.";
		const lines = jots.map(
			(j) =>
				`${j.id} [${j.kind}] ${j.status} ×${j.attempts} — ${(j.error ?? "").slice(0, 60)}`,
		);
		// The same pair the failure messages carry, a row per jot: run it again, or take it
		// out. Both reuse the `rt:`/`dl:` callback handlers in the bot.
		const kb = new InlineKeyboard();
		for (const j of jots)
			kb.text(`🔄 ${j.id}`, `rt:${j.id}`).text("🗑", `dl:${j.id}`).row();
		await ctx.reply(`⚠️ ${jots.length} failed:\n${lines.join("\n")}`, {
			reply_markup: kb,
		});
	},
};
