import { InlineKeyboard } from "grammy";
import { DELETE_NS, RETRY_NS } from "../../../libs/jot.ts";
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
      kb.text(`🔄 ${id}`, `${RETRY_NS}:${id}`)
        .text("🗑", `${DELETE_NS}:${id}`)
        .row();
    await ctx.reply(text, { reply_markup: kb });
  },
};
