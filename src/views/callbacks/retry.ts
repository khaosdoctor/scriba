import type { Composer, Context } from "grammy";
import type { JotController } from "../../controllers/jots.ts";
import { logger } from "../../libs/log.ts";
import { Responder } from "../chat.ts";
import { namespace } from "./namespace.ts";

const log = logger("bot");

/** 🔄 Retry (`rt:<jotId>`) on a failed jot's status message: reset its attempts and queue it
 *  now, rather than waiting for the retry pass. The tap is answered after the queueing. */
export function retryView(jots: JotController): Composer<Context> {
  return namespace("rt", async (ctx, [jotId]) => {
    const responder = new Responder(ctx);
    const jot = jotId ? await jots.get(jotId) : undefined;
    if (!jot) {
      log.warn({ jotId }, "retry: jot is gone");
      return responder.ack("gone");
    }
    // 🗑 Delete is right next to this button, so a stray tap must not put back the line
    // the owner just took out.
    if (jot.status === "deleted") {
      log.warn({ jotId }, "retry: jot was deleted");
      return responder.ack("deleted — not retrying");
    }
    log.info({ jotId, status: jot.status }, "manual retry requested");
    await jots.retry(jot.id);
    await responder.ack("retrying");
    await ctx.editMessageText("🔄 retrying…");
  });
}
