import { Composer, type Context } from "grammy";
import { fitTelegram } from "../../core.ts";
import type { CommandView } from "./index.ts";

/** /help lists the admin commands, itself included. It reads the live list, so a command
 *  added to it shows up here with no second edit. */
export function help(all: CommandView[]): CommandView {
  return {
    command: "help",
    description: "list admin commands",
    admin: true,
    view() {
      const view = new Composer<Context>();
      view.command("help", (ctx) =>
        ctx.reply(
          fitTelegram(
            [
              "🛠 commands:",
              ...all
                .filter((c) => c.admin)
                .map((c) => `/${c.command} — ${c.description}`),
            ].join("\n"),
          ),
        ),
      );
      return view;
    },
  };
}
