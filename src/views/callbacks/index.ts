import { Composer, type Context } from "grammy";
import { COMMAND_NS } from "../../flows/command.ts";
import { FOLLOWUP_NS } from "../../flows/followup.ts";
import { HABITS_NS } from "../../flows/habits/index.ts";
import { RATING_NS } from "../../flows/rating.ts";
import { REPROCESS_NS } from "../../flows/reprocess.ts";
import { TASKS_NS } from "../../flows/tasks/index.ts";
import { TIL_NS } from "../../flows/til.ts";
import type { ViewDeps } from "../index.ts";
import { namespace } from "./namespace.ts";
import { unrejectView } from "./unreject.ts";

/** One view per callback namespace, with the empty answer for an unknown namespace last so
 *  a stale button never leaves its spinner running. */
export function callbackViews({
  menu,
  command,
  tasks,
  til,
  rating,
  followup,
  habits,
  reprocess,
  jots,
  admin,
}: ViewDeps): Composer<Context>[] {
  const unknown = new Composer<Context>();
  unknown.on("callback_query:data", (ctx) => ctx.answerCallbackQuery());
  return [
    namespace("menu", (ctx, rest) => menu.handleCallback(ctx, rest)),
    namespace("vf", (ctx, [verdict, jotId]) =>
      jots.handleVoiceFix(ctx, verdict, jotId),
    ),
    namespace("rt", (ctx, [jotId]) => jots.handleRetry(ctx, jotId)),
    namespace("un", (ctx, [jotId]) => jots.handleRemove(ctx, jotId, "undo")),
    namespace("dl", (ctx, [jotId]) => jots.handleRemove(ctx, jotId, "discard")),
    namespace("em", (ctx, [jotId, on]) =>
      jots.handleEmbed(ctx, jotId, on === "1"),
    ),
    namespace(COMMAND_NS, (ctx, rest) => command.handleTap(ctx, rest)),
    namespace(TASKS_NS, (ctx, rest) => tasks.handleTap(ctx, rest)),
    namespace(TIL_NS, (ctx, rest) => til.handleTap(ctx, rest)),
    namespace("lk", (ctx, [verdict, pendingId]) =>
      jots.handleLink(ctx, verdict, pendingId),
    ),
    unrejectView(admin),
    namespace(RATING_NS, (ctx, [date, n]) => rating.handleTap(ctx, date, n)),
    namespace(FOLLOWUP_NS, (ctx, [code, date]) =>
      followup.handleTap(ctx, code, date),
    ),
    namespace(HABITS_NS, (ctx, [date, action, verdict]) =>
      habits.handleTap(ctx, date, action, verdict),
    ),
    namespace(REPROCESS_NS, (ctx, rest) => reprocess.handleTap(ctx, rest)),
    unknown,
  ];
}
