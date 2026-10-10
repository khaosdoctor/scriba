import { Composer, type Context } from "grammy";
import { DELETE_NS, UNDO_NS } from "../../libs/jot.ts";
import { unrejectView } from "./admin/unreject-tap.ts";
import { commandView } from "./command/tap.ts";
import { COMMANDS } from "./commands.ts";
import { habitsView } from "./habits/tap.ts";
import type { ViewDeps } from "./index.ts";
import { editView } from "./journal/edit.ts";
import { embedView } from "./journal/embed.ts";
import { linkView } from "./journal/link.ts";
import { removeView } from "./journal/remove.ts";
import { retryView } from "./journal/retry.ts";
import { voiceFixView } from "./journal/voicefix.ts";
import { followupView } from "./rating/followup-tap.ts";
import { ratingView } from "./rating/tap.ts";
import { reprocessView } from "./reprocess/tap.ts";
import { menuView } from "./settings/menu.ts";
import { tasksView } from "./tasks/tap.ts";
import { tilView } from "./til/tap.ts";

/** One view per callback namespace, with the empty answer for an unknown namespace last so
 *  a stale button never leaves its spinner running. */
export function callbackViews(deps: ViewDeps): Composer<Context>[] {
  const { command, tasks, jots, edits, rating, habits, admin } = deps;
  const unknown = new Composer<Context>();
  unknown.on("callback_query:data", (ctx) => ctx.answerCallbackQuery());
  return [
    menuView(deps, COMMANDS),
    voiceFixView(edits),
    retryView(jots),
    removeView(UNDO_NS, deps),
    removeView(DELETE_NS, deps),
    embedView(edits),
    editView(edits),
    commandView(command),
    tasksView(tasks),
    tilView(jots),
    linkView(edits),
    unrejectView(admin),
    ratingView(rating),
    followupView(rating),
    habitsView(habits),
    reprocessView(admin),
    unknown,
  ];
}
