import { logger } from "../../../libs/log.ts";
import type { CommandView } from "../commands.ts";
import { MENU_TEXT, rootKeyboard } from "./menu.ts";

const log = logger("menu");

/** `/menu` sends a fresh root menu and retires the chat's previous one. Later taps edit
 *  that message in place. */
export const menuCommand: CommandView = {
  command: "menu",
  description: "Open the interactive control menu",
  async run(ctx, { settings, menus }) {
    log.info("menu opened");
    await menus.retire(ctx.chat.id);
    const sent = await ctx.reply(MENU_TEXT, {
      reply_markup: rootKeyboard(await settings.root()),
    });
    menus.opened(ctx.chat.id, sent.message_id);
  },
};
