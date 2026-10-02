import { Composer, type Context, InlineKeyboard } from "grammy";
import type { CommandView } from "../commands.ts";

/** A row per failed jot with the same retry and delete pair the failure messages carry,
 *  served by the `rt:` and `dl:` callback views. */
export const failed: CommandView = {
  command: "failed",
  description: "recent failed/abandoned jots, each with retry + delete buttons",
  admin: true,
  view({ admin }) {
    const view = new Composer<Context>();
    view.command("failed", async (ctx) => {
      const { text, ids } = await admin.failed();
      if (!ids.length) return void (await ctx.reply(text));
      const kb = new InlineKeyboard();
      for (const id of ids)
        kb.text(`🔄 ${id}`, `rt:${id}`).text("🗑", `dl:${id}`).row();
      await ctx.reply(text, { reply_markup: kb });
    });
    return view;
  },
};
