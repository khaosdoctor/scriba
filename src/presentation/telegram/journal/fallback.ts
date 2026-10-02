import type { Bot } from "grammy";

/** Any message kind no view above claimed. */
export function fallbackView(bot: Bot): void {
  bot.on("message", (ctx) =>
    ctx.reply("scriba handles text, voice, images, and video for now."),
  );
}
