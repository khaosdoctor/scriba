import { InlineKeyboard } from "grammy";
import type { CommandView } from "../commands.ts";

export const failed: CommandView = {
  command: "failed",
  description: "recent failed/abandoned jots, each with retry + delete buttons",
  admin: true,
  async run(ctx, { admin }) {
    const { text, ids } = await admin.failed();
    if (!ids.length) return void (await ctx.reply(text));
    const kb = new InlineKeyboard();
    for (const id of ids)
      kb.text(`🔄 ${id}`, `rt:${id}`).text("🗑", `dl:${id}`).row();
    await ctx.reply(text, { reply_markup: kb });
  },
};
