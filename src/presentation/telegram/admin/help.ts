import { logger } from "../../../libs/log.ts";
import { fitTelegram } from "../../../libs/text.ts";
import type { CommandView } from "../commands.ts";

const log = logger("help");

export function help(all: CommandView[]): CommandView {
  return {
    command: "help",
    description: "list admin commands",
    admin: true,
    run(ctx) {
      const commands = all.filter((entry) => entry.admin);
      log.info({ count: commands.length }, "/help command");
      return ctx.reply(
        fitTelegram(
          [
            "🛠 commands:",
            ...commands.map(
              (entry) => `/${entry.command} — ${entry.description}`,
            ),
          ].join("\n"),
        ),
      );
    },
  };
}
