import type { Composer, Context } from "grammy";
import { followupFromCode } from "../../../libs/followup.ts";
import { logger } from "../../../libs/log.ts";
import { IsoDateSchema } from "../../../libs/time.ts";
import { FOLLOWUP_NS, type RatingService } from "../../../services/rating.ts";
import { Responder } from "../chat.ts";
import { namespace } from "../namespace.ts";

const log = logger("followup");

export function followupView(rating: RatingService): Composer<Context> {
  return namespace(FOLLOWUP_NS, async (ctx, [code, date]) => {
    const responder = new Responder(ctx);
    const question = followupFromCode(code);
    const day = IsoDateSchema.safeParse(date);
    if (!question || !day.success) {
      log.warn({ code, date }, "follow-up tap rejected: bad payload");
      return responder.ack("bad follow-up");
    }
    const message = ctx.callbackQuery.message;
    if (!message) {
      log.warn({ date, question }, "follow-up tap: prompt message is gone");
      return responder.ack();
    }
    if (!rating.claimSkip(question, day.data, message.message_id))
      return responder.ack();
    await responder.ack();
    await rating.skipFollowup(question, day.data, message.message_id);
  });
}
