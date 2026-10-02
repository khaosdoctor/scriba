import type { Composer, Context } from "grammy";
import { logger } from "../../../libs/log.ts";
import type { JotService } from "../../../services/jots.ts";
import { Responder } from "../chat.ts";
import { namespace } from "../namespace.ts";

const log = logger("bot");

export function retryView(jots: JotService): Composer<Context> {
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
    if ((await jots.retry(jot)) === "in-flight")
      return responder.ack("still processing");
    await responder.ack("retrying");
    await ctx.editMessageText("🔄 retrying…");
  });
}
