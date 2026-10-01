import type { Jot, Repository } from "../db.ts";
import { clipUpdate } from "../lib/feed.ts";
import { logger } from "../lib/log.ts";
import { escapeHtml } from "../lib/text.ts";
import type { Notifier } from "../models/ops.ts";
import type { FlushQueue } from "../runtime/queue.ts";
import type { ObsidianClient } from "../services/obsidian.ts";

const log = logger("til-flow");

/** Cap on the quoted jot. Escaping can grow a character to five, so this keeps the card
 *  well inside Telegram's 4096 whatever the jot holds. */
const QUOTE_CHARS = 600;

/** callback_query namespace of the "Move this to TIL?" card. */
export const TIL_NS = "ti";

export interface JotDeps {
  repo: Pick<
    Repository,
    | "getJot"
    | "groupFollowers"
    | "updateJot"
    | "markTilOffered"
    | "recentJots"
    | "resetForRetry"
    | "mapMessage"
  >;
  obsidian: Pick<ObsidianClient, "moveToTil">;
  notifier: Pick<Notifier, "send">;
  queue: Pick<FlushQueue, "add">;
}

export type TilOutcome =
  | "gone"
  | "kept"
  | "failed"
  | "no-line"
  | "no-heading"
  | "moved";

export class JotController {
  constructor(private deps: JotDeps) {}

  recent(limit: number): Promise<Jot[]> {
    return this.deps.repo.recentJots(limit);
  }

  get(id: string): Promise<Jot | undefined> {
    return this.deps.repo.getJot(id);
  }

  /** Put a jot back in the queue by hand. */
  async retry(id: string): Promise<void> {
    await this.deps.repo.resetForRetry(id);
    this.deps.queue.add([id]);
  }

  /** A force-reply prompt mapped to the jot, so the answer takes the normal reply-edit
   *  path with no new edit logic. */
  async askEdit(id: string): Promise<void> {
    const messageId = await this.deps.notifier.send(
      `✏️ Reply to this message with your edit for ${id} (or "delete" to remove it).`,
      { forceReply: true },
    );
    await this.deps.repo.mapMessage(messageId, id);
  }

  /**
   * "Move this to TIL?": a card for a jot the enricher read as something the owner learned.
   * The jot is already in the journal; accepting moves its line under the TIL heading of the
   * same note, keeping the anchor so edit, undo and reprocess still find it. The jot id is
   * all the card needs to carry, so there is no draft to store.
   */
  async askTil(jotId: string, text: string): Promise<void> {
    try {
      await this.deps.notifier.send(
        `💡 That sounds like a TIL. Move this to TIL?\n<blockquote>${escapeHtml(clipUpdate(text, QUOTE_CHARS))}</blockquote>`,
        {
          html: true,
          keyboard: {
            inline_keyboard: [
              [
                {
                  text: "✅ Move to TIL",
                  callback_data: `${TIL_NS}:y:${jotId}`,
                },
                {
                  text: "🚫 Keep in Journal",
                  callback_data: `${TIL_NS}:n:${jotId}`,
                },
              ],
            ],
          },
        },
      );
    } catch (err) {
      log.error({ err, jotId }, "til card failed to send");
      return;
    }
    // Marked only once the card is out, so a failed send leaves the offer for a reprocess.
    await this.deps.repo.markTilOffered(jotId);
    log.info({ jotId }, "til card sent");
  }

  async answerTil(
    jotId: string | undefined,
    accept: boolean,
  ): Promise<TilOutcome> {
    const { repo, obsidian } = this.deps;
    const jot = jotId ? await repo.getJot(jotId) : undefined;
    if (!jot || jot.status === "deleted") {
      log.warn({ jotId }, "til card: jot is gone");
      return "gone";
    }
    if (!accept) {
      log.info({ jotId }, "til declined, kept in the journal");
      return "kept";
    }
    const moved = await obsidian
      .moveToTil(jot.note_path, jot.anchor)
      .catch((err: unknown) => {
        log.error({ err, jotId }, "til move failed, line left in the journal");
        return null;
      });
    if (moved === null) return "failed";
    if (moved === "no-line") {
      log.warn({ jotId }, "til accepted but the line is no longer in the note");
      return "no-line";
    }
    if (moved === "no-heading") {
      log.warn({ jotId }, "til accepted but the note has no TIL heading");
      return "no-heading";
    }
    // The section decides which heading a re-written line goes back under, so it follows
    // the line: the leader's, and every squashed follower sharing it.
    const followers = await repo.groupFollowers(jot.id);
    for (const j of [jot, ...followers])
      await repo.updateJot(j.id, { section: "til" });
    log.info({ jotId }, "til accepted, line moved");
    return "moved";
  }
}
