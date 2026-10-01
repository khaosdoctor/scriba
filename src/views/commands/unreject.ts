import { Composer, type Context, InlineKeyboard } from "grammy";
import { fitTelegram } from "../../lib/text.ts";
import { UNREJECT_NS } from "../callbacks/unreject.ts";
import type { CommandView } from "./index.ts";

export const unreject: CommandView = {
  command: "unreject",
  description: "undo a link-rejection (menu, or /unreject <word> <note>)",
  admin: true,
  view({ admin }) {
    const view = new Composer<Context>();
    view.command("unreject", async (ctx) => {
      const out = await admin().unreject(String(ctx.match ?? ""));
      if (typeof out === "string")
        return void (await ctx.reply(fitTelegram(out)));
      const kb = new InlineKeyboard();
      for (const [i, surface] of out.surfaces.entries())
        kb.text(surface, `${UNREJECT_NS}:s:${i}`).row();
      // The keyboard has no pages to turn; the menu's link rules screens page through the
      // rest, so the text names the cut.
      const cut = out.total > out.surfaces.length;
      await ctx.reply(
        cut
          ? `Pick a rejected word to unreject (${out.surfaces.length} of ${out.total} — /menu › 🔗 Link rules pages through the rest):`
          : "Pick a rejected word to unreject:",
        { reply_markup: kb },
      );
    });
    return view;
  },
};
