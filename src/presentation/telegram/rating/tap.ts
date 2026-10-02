import type { Composer, Context } from "grammy";
import { z } from "zod";
import { RatingSchema } from "../../../domain/rating/entity.ts";
import { logger } from "../../../libs/log.ts";
import { DATE_RE } from "../../../libs/time.ts";
import { RATING_NS, type RatingService } from "../../../services/rating.ts";
import { Responder } from "../chat.ts";
import { namespace } from "../namespace.ts";

const log = logger("rating");

const Payload = z.tuple([z.string().regex(DATE_RE), RatingSchema]);

/** `rate:<date>:<n>` records the day's rating. The tap is answered after the database claim
 *  and the frontmatter write, and the buttons are replaced by the result so the day can't be
 *  rated twice. */
export function ratingView(rating: RatingService): Composer<Context> {
  return namespace(RATING_NS, async (ctx, [date, n]) => {
    const responder = new Responder(ctx);
    log.debug({ date, n }, "rating button tapped");
    const payload = Payload.safeParse([date, n]);
    if (!payload.success) {
      log.warn({ date, n }, "rating tap rejected: bad payload");
      return responder.ack("bad rating");
    }
    const [day, score] = payload.data;
    const outcome = await rating.rate(day, score);
    if (outcome.kind === "already") {
      await responder.ack(`already rated ${outcome.current}/10`);
      await ctx.editMessageText(
        `📊 ${day} already rated ${outcome.current}/10.`,
      );
      return;
    }
    await responder.ack(`saved ${score}/10`);
    await ctx.editMessageText(`📊 ${day} rated ${score}/10`);
    // The rating is already saved, so a failed question must not undo the tap.
    await rating
      .startFollowup(day)
      .catch((err) =>
        log.error({ err, date: day }, "follow-up failed to start"),
      );
  });
}
