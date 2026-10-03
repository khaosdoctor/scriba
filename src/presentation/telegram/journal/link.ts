import type { Composer, Context } from "grammy";
import { type EditService, LINK_NS } from "../../../services/edits.ts";
import { Responder } from "../chat.ts";
import { namespace } from "../namespace.ts";

export function linkView(edits: EditService): Composer<Context> {
  return namespace(LINK_NS, async (ctx, [verdict, pendingId]) => {
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
