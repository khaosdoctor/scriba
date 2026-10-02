import type { CommandView } from "../commands.ts";

export const start: CommandView = {
  command: "start",
  description: "What scriba does",
  run(ctx) {
    return ctx.reply(
      "scriba ready. Send text or a voice note to journal. /help for admin commands.",
    );
  },
};
