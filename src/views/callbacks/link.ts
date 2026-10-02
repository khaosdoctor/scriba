import type { Composer, Context } from "grammy";
import type { EditController } from "../../services/edits.ts";
import { Responder } from "../chat.ts";
import { namespace } from "./namespace.ts";

/** `lk:y:<id>` and `lk:n:<id>`: the answer to a "Link X → [[Note]]?" card. The tap is
 *  answered after the pair is learned or the line rewritten, so the toast can say which. */
export function linkView(edits: EditController): Composer<Context> {
  return namespace("lk", async (ctx, [verdict, pendingId]) => {
    const responder = new Responder(ctx);
    if (!pendingId) return responder.ack();
    const outcome = await edits.confirmLink(pendingId, verdict !== "n");
    if (outcome === "expired") return responder.ack("expired");
    const { surface, note } = outcome;
    if (outcome.verdict === "rejected") {
      await responder.ack("won't link again");
      return void ctx.editMessageText(
        `✋ "${surface}" ✗ [[${note}]] (won't ask again)`,
      );
    }
    const applied = outcome.verdict === "linked";
    await responder.ack(applied ? "linked" : "no change");
    await ctx.editMessageText(
      applied
        ? `🔗 "${surface}" → [[${note}]]`
        : `"${surface}": nothing to link`,
    );
  });
}
