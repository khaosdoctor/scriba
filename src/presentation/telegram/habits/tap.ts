import type { Composer, Context } from "grammy";
import { logger } from "../../../libs/log.ts";
import { isIsoDate } from "../../../libs/time.ts";
import { HABITS_NS, type HabitService } from "../../../services/habits.ts";
import { namespace } from "../namespace.ts";

const log = logger("habits");

export function habitsView(habits: HabitService): Composer<Context> {
  return namespace(
    HABITS_NS,
    async (ctx, [date, action, digest, verd], responder) => {
      log.debug({ date, action, verd }, "habit button tapped");
      if (!date || !isIsoDate(date)) {
        log.warn({ date, action, verd }, "habit tap rejected: bad payload");
        return responder.ack("bad habit");
      }
      if (action === "begin") {
        await responder.ack();
        return habits.ask(date, 0, ctx.callbackQuery.message?.message_id);
      }
      const index = Number(action);
      if (!Number.isInteger(index) || !digest) {
        log.warn({ date, action, verd }, "habit tap rejected: bad index");
        return responder.ack("bad habit");
      }
      if (!(await habits.tap(date, index, digest, verd === "y")))
        return responder.ack("gone");
      await responder.ack();
      await habits.ask(date, index + 1);
    },
  );
}
