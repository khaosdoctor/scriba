import { Composer, type Context } from "grammy";
import { MENU_TEXT, rootKeyboard } from "../callbacks/menu.ts";
import type { CommandView } from "./index.ts";

/** `/menu` sends a fresh root menu and retires the chat's previous one. Later taps edit
 *  that message in place. */
export const menuCommand: CommandView = {
  command: "menu",
  description: "Open the interactive control menu",
  view({ settings, menus }) {
    const view = new Composer<Context>();
    view.command("menu", async (ctx) => {
      await menus.retire(ctx.chat.id);
      const sent = await ctx.reply(MENU_TEXT, {
        reply_markup: rootKeyboard(await settings.root()),
      });
      menus.opened(ctx.chat.id, sent.message_id);
    });
    return view;
  },
};
