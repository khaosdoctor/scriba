import { Composer, type Context } from "grammy";
import { COMMAND_NS } from "../../flows/command.ts";
import type { ViewDeps } from "../index.ts";
import { followupView } from "./followup.ts";
import { habitsView } from "./habits.ts";
import { menuView } from "./menu.ts";
import { namespace } from "./namespace.ts";
import { ratingView } from "./rating.ts";
import { reprocessView } from "./reprocess.ts";
import { tasksView } from "./tasks.ts";
import { tilView } from "./til.ts";
import { unrejectView } from "./unreject.ts";

/** One view per callback namespace, with the empty answer for an unknown namespace last so
 *  a stale button never leaves its spinner running. */
export function callbackViews(deps: ViewDeps): Composer<Context>[] {
  const { command, tasks, jotController, rating, habits, jots, admin } = deps;
  const unknown = new Composer<Context>();
  unknown.on("callback_query:data", (ctx) => ctx.answerCallbackQuery());
  return [
    menuView(deps),
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
    tasksView(tasks),
    tilView(jotController),
    namespace("lk", (ctx, [verdict, pendingId]) =>
      jots.handleLink(ctx, verdict, pendingId),
    ),
    unrejectView(admin),
    ratingView(rating),
    followupView(rating),
    habitsView(habits),
    reprocessView(admin),
    unknown,
  ];
}
