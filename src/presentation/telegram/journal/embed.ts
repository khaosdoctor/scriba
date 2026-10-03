import type { Composer, Context } from "grammy";
import { EMBED_NS } from "../../../libs/jot.ts";
import type { EditService } from "../../../services/edits.ts";
import { namespace } from "../namespace.ts";

export function embedView(edits: EditService): Composer<Context> {
  return namespace(EMBED_NS, async (_ctx, [jotId, on], responder) => {
    const embed = on === "1";
    const outcome = await edits.toggleEmbed(jotId, embed);
    if (outcome === "gone") return responder.ack("gone");
    if (outcome === "no-line") return responder.ack("line not found");
    await responder.ack(embed ? "embedded" : "plain link");
    await outcome.confirm();
  });
}
