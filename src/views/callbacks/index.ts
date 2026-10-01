import { Composer, type Context } from "grammy";
import { COMMAND_NS } from "../../flows/command.ts";
import { REPROCESS_NS } from "../../flows/reprocess.ts";
import { TASKS_NS } from "../../flows/tasks/index.ts";
import type { ViewDeps } from "../index.ts";
import { followupView } from "./followup.ts";
import { habitsView } from "./habits.ts";
import { namespace } from "./namespace.ts";
import { ratingView } from "./rating.ts";
import { tilView } from "./til.ts";
import { unrejectView } from "./unreject.ts";

/** One view per callback namespace, with the empty answer for an unknown namespace last so
 *  a stale button never leaves its spinner running. */
export function callbackViews({
  menu,
  command,
  tasks,
  jotController,
  rating,
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
    tilView(jotController),
    namespace("lk", (ctx, [verdict, pendingId]) =>
      jots.handleLink(ctx, verdict, pendingId),
    ),
    unrejectView(admin),
    ratingView(rating),
    followupView(rating),
    habitsView(habits),
    namespace(REPROCESS_NS, (ctx, rest) => reprocess.handleTap(ctx, rest)),
    unknown,
  ];
}
