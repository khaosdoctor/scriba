import type { Composer, Context } from "grammy";
import { ORIGINAL_NS } from "../../../libs/jot.ts";
import type { EditService } from "../../../services/edits.ts";
import { namespace } from "../namespace.ts";

const TOASTS = {
  gone: "gone",
  busy: "still processing",
  queued: "using the original transcript",
} as const;

/** 📝 Use original on a finished voice jot whose transcript the voice fix rewrote. */
export function voiceFixView(edits: EditService): Composer<Context> {
  return namespace(ORIGINAL_NS, async (ctx, [jotId], responder) => {
    const outcome = await edits.useOriginal(jotId);
    await responder.ack(TOASTS[outcome]);
    if (outcome === "queued")
      await ctx.editMessageText(
        "📝 reprocessing with the original transcript…",
      );
  });
}
