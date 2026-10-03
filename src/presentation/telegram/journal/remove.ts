import type { Composer, Context } from "grammy";
import { DELETE_NS, UNDO_NS } from "../../../libs/jot.ts";
import { logger } from "../../../libs/log.ts";
import type { ViewDeps } from "../index.ts";
import { namespace } from "../namespace.ts";
import { STILL_PROCESSING } from "./edit-reply.ts";

const log = logger("bot");

type Namespace = typeof UNDO_NS | typeof DELETE_NS;

const REMOVALS: Record<
  Namespace,
  { source: "undo" | "discard"; toast: string; already: string }
> = {
  [UNDO_NS]: { source: "undo", toast: "undoing", already: "already undone" },
  [DELETE_NS]: {
    source: "discard",
    toast: "deleting",
    already: "already deleted",
  },
};

export function removeView(
  ns: Namespace,
  { jotController, edits }: ViewDeps,
): Composer<Context> {
  const { source, toast, already } = REMOVALS[ns];
  return namespace(ns, async (_ctx, [jotId], responder) => {
    const jot = jotId ? await jotController.get(jotId) : undefined;
    if (!jot) {
      log.warn({ jotId, source }, "remove: jot is gone");
      return responder.ack("gone");
    }
    if (jot.status === "deleted") {
      log.warn({ jotId, source }, "remove: already removed");
      return responder.ack(already);
    }
    const outcome =
      source === "undo" ? await edits.undo(jot) : await edits.discard(jot);
    if (outcome === "stale") {
      await responder.ack();
      return responder.dropButtons(`${ns}:`);
    }
    if (outcome === "removal-queued")
      return responder.ack(STILL_PROCESSING[outcome]);
    log.info({ jotId, source, status: jot.status }, "jot removal requested");
    await responder.ack(toast);
    await outcome.now();
  });
}
