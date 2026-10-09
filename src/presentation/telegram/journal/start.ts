import type { CommandView } from "../commands.ts";

export const start: CommandView = {
  command: "start",
  description: "What scriba does",
  example: "/start → a reminder that anything you send goes to the journal",
  run(ctx) {
    return ctx.reply(
      "scriba ready. Send text or a voice note to journal. /help lists every command.",
    );
  },
};
