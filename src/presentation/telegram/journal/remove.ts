import type { Composer, Context } from "grammy";
import { logger } from "../../../libs/log.ts";
import { Responder } from "../chat.ts";
import type { ViewDeps } from "../index.ts";
import { namespace } from "../namespace.ts";

const log = logger("bot");

type Namespace = "un" | "dl";

const REMOVALS: Record<
  Namespace,
  { source: "undo" | "discard"; toast: string; already: string }
> = {
  un: { source: "undo", toast: "undoing", already: "already undone" },
  dl: { source: "discard", toast: "deleting", already: "already deleted" },
};

/** ↩️ Undo (`un:<jotId>`) on a finished jot and 🗑 Delete (`dl:<jotId>`) on a failed one
 *  pull the line back out of the journal, the same as `/delete`. The tap is answered before
 *  the vault write. */
export function removeView(
  ns: Namespace,
  { jotController, edits }: ViewDeps,
): Composer<Context> {
  const { source, toast, already } = REMOVALS[ns];
  return namespace(ns, async (ctx, [jotId]) => {
    const responder = new Responder(ctx);
    const jot = jotId ? await jotController.get(jotId) : undefined;
    if (!jot) {
      log.warn({ jotId, source }, "remove: jot is gone");
      return responder.ack("gone");
    }
    if (jot.status === "deleted") {
      log.warn({ jotId, source }, "remove: already removed");
      return responder.ack(already);
    }
    log.info({ jotId, source, status: jot.status }, "jot removal requested");
    await responder.ack(toast);
    await edits.remove(jot);
  });
}
