import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";
import { commandView } from "./command.ts";
import { embedView } from "./embed.ts";
import { followupView } from "./followup.ts";
import { habitsView } from "./habits.ts";
import { linkView } from "./link.ts";
import { menuView } from "./menu.ts";
import { ratingView } from "./rating.ts";
import { removeView } from "./remove.ts";
import { reprocessView } from "./reprocess.ts";
import { retryView } from "./retry.ts";
import { tasksView } from "./tasks.ts";
import { tilView } from "./til.ts";
import { unrejectView } from "./unreject.ts";
import { voiceFixView } from "./voicefix.ts";

/** One view per callback namespace, with the empty answer for an unknown namespace last so
 *  a stale button never leaves its spinner running. */
export function callbackViews(deps: ViewDeps): Composer<Context>[] {
  const { command, tasks, jotController, edits, rating, habits, admin } = deps;
  const unknown = new Composer<Context>();
  unknown.on("callback_query:data", (ctx) => ctx.answerCallbackQuery());
  return [
    menuView(deps),
    voiceFixView(jotController),
    retryView(jotController),
    removeView("un", deps),
    removeView("dl", deps),
    embedView(edits),
    commandView(command),
    tasksView(tasks),
    tilView(jotController),
    linkView(edits),
    unrejectView(admin),
    ratingView(rating),
    followupView(rating),
    habitsView(habits),
    reprocessView(admin),
    unknown,
  ];
}
