import { Composer, type Context, type Filter } from "grammy";
import type { Message } from "grammy/types";
import { parseHabitRef } from "../../lib/habits.ts";
import type { ViewDeps } from "../index.ts";
import { followupReply, parseFollowupRef } from "./followup.ts";
import { habitReply } from "./habit.ts";
import { parseTaskRef, taskReply } from "./task.ts";
import {
  linkReply,
  parseLinkRef,
  parseSettingsRef,
  wizardReply,
} from "./wizard.ts";

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

/** The prompt replies in the order their owners get to claim one: habit value, follow-up
 *  question, settings prompt, link wizard step, task card prompt. */
export function promptReplies(deps: ViewDeps): Composer<Context>[] {
  const { habits, rating, jotController, tasks } = deps;
  return [
    replyTo(parseHabitRef, habitReply(habits)),
    replyTo(parseFollowupRef, followupReply(rating, jotController)),
    replyTo(parseSettingsRef, wizardReply(deps)),
    replyTo(parseLinkRef, linkReply(deps)),
    replyTo(parseTaskRef, taskReply(tasks)),
  ];
}
