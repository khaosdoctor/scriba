import { Composer, type Context, type Filter } from "grammy";
import { parseFollowupRef } from "../../core.ts";
import { parseHabitRef } from "../../flows/habits/index.ts";
import type { ViewDeps } from "../index.ts";

type Reply = Filter<Context, "message:text">;

/** A text reply whose quoted prompt `parse` recognizes. A reply to a message with no text
 *  is parsed as an empty prompt, which no marker matches. */
function replyTo<T>(
  parse: (prompt: string) => T | null,
  handle: (ctx: Reply, parsed: T) => Promise<unknown>,
): Composer<Context> {
  const view = new Composer<Context>();
  view.on("message:text", async (ctx, next) => {
    const quoted = ctx.message.reply_to_message;
    const parsed = quoted ? parse(quoted.text ?? "") : null;
    if (parsed === null) return next();
    await handle(ctx, parsed);
  });
  return view;
}

const claim = (owns: (prompt: string) => boolean) => (prompt: string) =>
  owns(prompt) ? prompt : null;

/** The prompt replies in the order their owners get to claim one: habit value, follow-up
 *  question, link wizard step, task card prompt. */
export function promptReplies({
  habits,
  followup,
  menu,
  tasks,
}: ViewDeps): Composer<Context>[] {
  return [
    replyTo(parseHabitRef, (ctx) => habits.handleReply(ctx)),
    replyTo(parseFollowupRef, (ctx, ref) => followup.handleReply(ctx, ref)),
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
