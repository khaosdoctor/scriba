import type { Bot } from "grammy";
import { MERGE_EMOJI } from "../../../services/jots.ts";
import type { ViewDeps } from "../index.ts";

export function reactionView(bot: Bot, { jotController }: ViewDeps): void {
  bot.on("message_reaction", (ctx) => {
    if (!ctx.reactions().emojiAdded.includes(MERGE_EMOJI)) return;
    return jotController.optOutOfSquash(ctx.messageReaction.message_id);
  });
}
