import { InlineKeyboard } from "grammy";
import type { Command } from "./types.ts";

export const failed: Command = {
  name: "failed",
  description: "recent failed/abandoned jots, each with a retry button",
  run: async (ctx, _args, d) => {
    const jots = await d.repo.failedJots(10);
    if (!jots.length) return "✅ nothing failed.";
    const lines = jots.map((j) => `${j.id} [${j.kind}] ${j.status} ×${j.attempts} — ${(j.error ?? "").slice(0, 60)}`);
    // One retry button per jot; reuses the existing `rt:` callback handler in the bot.
    const kb = new InlineKeyboard();
    for (const j of jots) kb.text(`🔄 ${j.id}`, `rt:${j.id}`).row();
    await ctx.reply(`⚠️ ${jots.length} failed:\n${lines.join("\n")}`, { reply_markup: kb });
  },
};
