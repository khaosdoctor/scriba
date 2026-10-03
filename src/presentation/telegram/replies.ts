import { Composer, type Context, type Filter } from "grammy";
import type { Message } from "grammy/types";
import { parseFollowupRef } from "../../libs/followup.ts";
import { parseHabitRef } from "../../libs/habits.ts";
import { parseTaskRef } from "../../libs/tasks.ts";
import { habitReply } from "./habits/reply.ts";
import type { ViewDeps } from "./index.ts";
import { followupReply } from "./rating/followup-reply.ts";
import {
  linkReply,
  parseLinkRef,
  parseSettingsRef,
  wizardReply,
} from "./settings/wizard.ts";
import { taskReply } from "./tasks/reply.ts";

type Reply = Filter<Context, "message:text">;

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
