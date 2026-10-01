import { Composer, type Context, type Filter } from "grammy";
import type { Message } from "grammy/types";
import { parseHabitRef } from "../../lib/habits.ts";
import type { ViewDeps } from "../index.ts";
import { followupReply, parseFollowupRef } from "./followup.ts";
import { habitReply } from "./habit.ts";

type Reply = Filter<Context, "message:text">;

/** A text reply whose quoted prompt `parse` recognizes. A reply to a message with no text
 *  is parsed as an empty prompt, which no marker matches. */
function replyTo<T>(
  parse: (prompt: string) => T | null,
  handle: (ctx: Reply, parsed: T, quoted: Message) => Promise<unknown>,
): Composer<Context> {
  const view = new Composer<Context>();
  view.on("message:text", async (ctx, next) => {
    const quoted = ctx.message.reply_to_message;
    const parsed = quoted ? parse(quoted.text ?? "") : null;
    if (!quoted || parsed === null) return next();
    await handle(ctx, parsed, quoted);
  });
  return view;
}

const claim = (owns: (prompt: string) => boolean) => (prompt: string) =>
  owns(prompt) ? prompt : null;

/** The prompt replies in the order their owners get to claim one: habit value, follow-up
 *  question, link wizard step, task card prompt. */
export function promptReplies({
  habits,
  rating,
  jots,
  menu,
  tasks,
}: ViewDeps): Composer<Context>[] {
  return [
    replyTo(parseHabitRef, habitReply(habits)),
    replyTo(parseFollowupRef, followupReply(rating, jots)),
    replyTo(
      claim((prompt) => menu.isWizardPrompt(prompt)),
      (ctx, prompt) => menu.handleWizardReply(ctx, prompt),
    ),
    replyTo(
      claim((prompt) => tasks.isTaskPrompt(prompt)),
      (ctx, prompt) => tasks.handleReply(ctx, prompt),
    ),
  ];
}
