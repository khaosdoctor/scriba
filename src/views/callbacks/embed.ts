import type { Composer, Context } from "grammy";
import type { EditController } from "../../services/edits.ts";
import { Responder } from "../chat.ts";
import { namespace } from "./namespace.ts";

/** 🖼 Embed (`em:<jotId>:1`) and 🔗 Plain link (`em:<jotId>:0`) on a finished jot's status
 *  message. The tap is answered after the line is rewritten; the status card then offers
 *  the opposite, so the choice can be undone with the next tap. */
export function embedView(edits: EditController): Composer<Context> {
  return namespace("em", async (ctx, [jotId, on]) => {
    const embed = on === "1";
    const responder = new Responder(ctx);
    const outcome = await edits.toggleEmbed(jotId, embed);
    if (outcome === "gone") return responder.ack("gone");
    if (outcome === "no-line") return responder.ack("line not found");
    await responder.ack(embed ? "embedded" : "plain link");
    await outcome.confirm();
  });
}
