import type { Composer, Context } from "grammy";
import type { JotService, VoiceFixChoice } from "../../../services/jots.ts";
import { Responder } from "../chat.ts";
import { namespace } from "../namespace.ts";

const TOASTS: Record<VoiceFixChoice, string> = {
  proposed: "using fixed version",
  original: "keeping original",
};

/** `vf:o:<jotId>` keeps the original transcript, `vf:p:<jotId>` takes the proposed fix.
 *  The tap is answered before the pick reaches the waiting processor. */
export function voiceFixView(jots: JotService): Composer<Context> {
  return namespace("vf", async (ctx, [verdict, jotId]) => {
    const responder = new Responder(ctx);
    if (!jotId || !verdict) return responder.ack();
    const choice: VoiceFixChoice = verdict === "p" ? "proposed" : "original";
    const settle = jots.pickVoiceFix(jotId, choice);
    if (!settle) return responder.ack("expired");
    await responder.ack(TOASTS[choice]);
    settle();
  });
}
