import { Composer, type Context } from "grammy";
import type { AdminController } from "../../controllers/admin.ts";
import { fitTelegram } from "../../lib/text.ts";
import type { CommandView } from "./index.ts";

/** An admin command that answers with one text. fitTelegram turns an oversized answer
 *  into a labelled cut instead of a rejected send. */
export function textCommand(
  command: string,
  description: string,
  answer: (admin: AdminController, args: string) => string | Promise<string>,
): CommandView {
  return {
    command,
    description,
    admin: true,
    view({ admin }) {
      const view = new Composer<Context>();
      view.command(command, async (ctx) => {
        const text = await answer(admin, String(ctx.match ?? ""));
        await ctx.reply(fitTelegram(text));
      });
      return view;
    },
  };
}
