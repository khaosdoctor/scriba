import type { Composer, Context } from "grammy";
import { logger } from "../../../libs/log.ts";
import { DATE_RE } from "../../../libs/time.ts";
import { HABITS_NS, type HabitService } from "../../../services/habits.ts";
import { Responder } from "../chat.ts";
import { namespace } from "../namespace.ts";

const log = logger("habits");

/** `hb:<date>:begin` starts the review. `hb:<date>:<index>:<y|n>` answers one habit, and the
 *  tap is answered once the note is written, before the next question replaces the card. */
export function habitsView(habits: HabitService): Composer<Context> {
  return namespace(HABITS_NS, async (ctx, [date, action, verd]) => {
    const responder = new Responder(ctx);
    if (!date || !DATE_RE.test(date)) {
      log.warn({ date, action, verd }, "habit tap rejected: bad payload");
      return responder.ack("bad habit");
    }
    if (action === "begin") {
      await responder.ack();
      return habits.ask(date, 0, ctx.callbackQuery.message?.message_id);
    }
    const index = Number(action);
    if (!Number.isInteger(index)) {
      log.warn({ date, action, verd }, "habit tap rejected: bad index");
      return responder.ack("bad habit");
    }
    if (!(await habits.tap(date, index, verd === "y")))
      return responder.ack("gone");
    await responder.ack();
    await habits.ask(date, index + 1);
  });
}
