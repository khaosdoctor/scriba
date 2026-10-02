import type { Bot } from "grammy";

export function fallbackView(bot: Bot): void {
  bot.on("message", (ctx) =>
    ctx.reply("scriba handles text, voice, images, and video for now."),
  );
}
