import { Composer, type Context } from "grammy";
import type { CommandView } from "./index.ts";

/** Reply to a jot's message with /delete to remove its journal line: the explicit
 *  counterpart to clearing the message text, since Telegram never delivers a message
 *  delete to bots. */
export const deleteCommand: CommandView = {
  command: "delete",
  description: "Reply to a journal message with /delete to remove it",
  view({ jots }) {
    const view = new Composer<Context>();
    view.command("delete", (ctx) => jots.handleDeleteCommand(ctx));
    return view;
  },
};
