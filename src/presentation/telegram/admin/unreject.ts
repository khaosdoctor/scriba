import { InlineKeyboard } from "grammy";
import { fitTelegram } from "../../../libs/text.ts";
import type { CommandView } from "../commands.ts";
import { UNREJECT_NS } from "./unreject-tap.ts";

export const unreject: CommandView = {
  command: "unreject",
  description: "undo a link-rejection (menu, or /unreject <word> <note>)",
  example: "/unreject apple Apple → 'apple' can be linked to [[Apple]] again",
  admin: true,
  async run(ctx, { admin }) {
    const out = await admin.unreject(ctx.match);
    if (typeof out === "string")
      return void (await ctx.reply(fitTelegram(out)));
    const kb = new InlineKeyboard();
    for (const [index, surface] of out.surfaces.entries())
      kb.text(surface, `${UNREJECT_NS}:s:${index}`).row();
    const cut = out.total > out.surfaces.length;
    await ctx.reply(
      cut
        ? `Pick a rejected word to unreject (${out.surfaces.length} of ${out.total} — /menu › 🔗 Link rules pages through the rest):`
        : "Pick a rejected word to unreject:",
      { reply_markup: kb },
    );
  },
};
