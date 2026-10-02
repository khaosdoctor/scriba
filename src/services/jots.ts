import type { Repository } from "../data/repositories/index.ts";
import type { ObsidianClient } from "../data/repositories/notes.ts";
import type { Jot, JotSection } from "../domain/jot/entity.ts";
import type { IntakeInput } from "../domain/jot/structures.ts";
import { clipUpdate } from "../libs/feed.ts";
import {
  makeJotId,
  type StatusButtons,
  statusKeyboard,
  withinSquashWindow,
} from "../libs/jot.ts";
import { logger } from "../libs/log.ts";
import { placeholderLine, stripTilPrefix } from "../libs/note.ts";
import type { FlushQueue } from "../libs/queue.ts";
import { escapeHtml } from "../libs/text.ts";
import { dayBounds, plainDate, plainTime } from "../libs/time.ts";
import type { Notifier } from "./notifier.ts";

const log = logger("bot");
const tilLog = logger("til-flow");

/** Cap on the quoted jot. Escaping can grow a character to five, so this keeps the card
 *  well inside Telegram's 4096 whatever the jot holds. */
const QUOTE_CHARS = 600;

/** callback_query namespace of the "Move this to TIL?" card. */
export const TIL_NS = "ti";

/** Set (in place of ✍) on a squashed follower's message, marking it as slated to merge
 *  into the previous jot's line. Telegram bots can set at most one reaction per message
 *  (non-Premium), so this replaces rather than joins the receipt ack. The owner reacting
 *  with 🤝 themselves is the opt-out: it pulls the jot back out into its own line. */
export const MERGE_EMOJI = "🤝" as const;

/** Telegram only allows a fixed emoji set for reactions, so ⏳/✅/❌ aren't available:
 *  👌 (done), 🤔 (retrying), 😱 (failed) are the closest. */
const OUTCOME_EMOJI: Record<JotOutcome, string> = {
  done: "👌",
  retrying: "🤔",
  failed: "😱",
};

export type JotOutcome = "done" | "failed" | "retrying";
export type VoiceFixChoice = "original" | "proposed";
export type RetryOutcome = "queued" | "in-flight";

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
    | "unmapMessage"
    | "insertJot"
    | "lastPendingEnrichableJot"
    | "jotForMessage"
    | "messageForJot"
    | "unsquash"
  >;
  obsidian: Pick<
    ObsidianClient,
    "moveToTil" | "dailyPath" | "ensureDailyNote" | "appendJournalLine"
  >;
  notifier: Notifier;
  queue: Pick<FlushQueue, "add">;
  /** A text or voice jot this soon after a pending one folds into its line. */
  squashWindowMs: number;
}

export type TilOutcome =
  | "gone"
  | "kept"
  | "failed"
  | "no-line"
  | "no-heading"
  | "moved";

export class JotService {
  // jotId -> the live status message edited in place through the jot's lifecycle. In
  // memory: after a restart status() posts a fresh message, nothing is lost.
  private statusMsgs = new Map<string, number>();
  // jotId -> the processor's wait for the owner's pick between the two transcripts.
  private voiceFixPending = new Map<string, (choice: VoiceFixChoice) => void>();

  constructor(private deps: JotDeps) {}

  recent(limit: number): Promise<Jot[]> {
    return this.deps.repo.recentJots(limit);
  }

  get(id: string): Promise<Jot | undefined> {
    return this.deps.repo.getJot(id);
  }

  /** The jot whose line a tap on `jot` is about. A squashed follower shares its leader's
   *  line, so the leader is what gets retried or removed, unless the leader is gone and
   *  the follower was written on its own, the processor's own rule. */
  async leaderOf(jot: Jot): Promise<Jot> {
    if (jot.anchor === jot.id) return jot;
    const leader = await this.deps.repo.getJot(jot.anchor);
    return leader && leader.status !== "deleted" ? leader : jot;
  }

  /** The jot a Telegram message belongs to: the owner's own message or a status message. */
  async byMessage(messageId: number): Promise<Jot | undefined> {
    const id = await this.deps.repo.jotForMessage(messageId);
    return id ? this.deps.repo.getJot(id) : undefined;
  }

  /** A message becomes a pending jot: the squash decision, the receipt reaction, the row,
   *  the message map, the placeholder line (skipped when squashed) and the queue, in that
   *  order. */
  async intake(input: IntakeInput): Promise<void> {
    const { repo, obsidian, notifier } = this.deps;
    // `day` files the jot under another day's note (the follow-up after rating yesterday):
    // the last second of that day, so it reads as the day's final entry.
    const epochMs =
      input.day && input.day !== plainDate(input.sentAt)
        ? dayBounds(input.day)[1] - 1000
        : input.sentAt;
    const id = makeJotId();
    const date = plainDate(epochMs);
    const time = plainTime(epochMs);
    // dailyPath is pure (no REST call), so the row can be persisted even when Obsidian is
    // down. ensureDailyNote + the placeholder write happen after, and writeLine recreates
    // the note on flush, so a failed placeholder self-heals.
    const notePath = obsidian.dailyPath(date);
    const tilText =
      input.kind === "text" ? stripTilPrefix(input.rawText ?? "") : null;
    const section: JotSection = tilText === null ? "journal" : "til";
    const rawText = tilText ?? input.rawText;

    // A text/voice jot arriving within the squash window of the previous still-pending
    // text/voice jot in this note folds into that jot's line: it shares the leader's anchor
    // and skips its own placeholder, so the processor (which groups by anchor) enriches
    // them into one line. Attach-only kinds never squash. Decided before the reaction, so
    // a squashed follower gets the 🤝 marker on the same react() call.
    let anchor = id;
    let squashed = false;
    // A follow-up answer (`day`) is stamped with the day's last second, so two of them would
    // always look like one burst: they are deliberate entries and never squash.
    if (!input.day && (input.kind === "text" || input.kind === "audio")) {
      const prev = await repo.lastPendingEnrichableJot(notePath, section);
      if (
        prev &&
        withinSquashWindow(prev.received_at, epochMs, this.deps.squashWindowMs)
      ) {
        anchor = prev.anchor;
        squashed = true;
        log.info(
          { id, into: anchor, gapMs: epochMs - prev.received_at },
          "jot squashed into open run",
        );
      }
    }

    // Receipt reaction (✍ = received/awaiting), swapped to 👌/😱 by react() once processing
    // settles. Best-effort: intake proceeds if it fails.
    await notifier.react(input.messageId, squashed ? MERGE_EMOJI : "✍");
    log.info(
      {
        id,
        kind: input.kind,
        date,
        time,
        hasFile: !!input.fileId,
        hasText: !!input.rawText,
      },
      "jot received",
    );

    const now = Date.now();
    const jot: Jot = {
      id,
      kind: input.kind,
      note_path: notePath,
      anchor,
      time,
      raw_text: rawText,
      transcript: null,
      proposed_text: null,
      section,
      asset_path: null,
      file_id: input.fileId ?? null,
      status: "pending",
      attempts: 0,
      error: null,
      received_at: epochMs,
      updated_at: now,
    };
    // The row goes in BEFORE the placeholder line. A crash between the two leaves a row with
    // no line, which self-heals: writeLine falls back to appendJournalLine on a missing
    // anchor. The reverse (a line with no row) would orphan a placeholder nothing can find.
    await repo.insertJot(jot);
    // Mapped BEFORE the network write below so the jot is retryable even if the placeholder
    // write throws (Obsidian down): bot.catch finds this jot by message id and offers a
    // retry button. Queueing stays last so ordering matches the normal path.
    await repo.mapMessage(input.messageId, id);
    // A squashed follower reuses the leader's placeholder; writing its own would add a
    // second line the processor would then have to reconcile away.
    if (squashed) {
      log.debug({ id, anchor }, "squashed — reusing leader placeholder");
    } else {
      await obsidian.ensureDailyNote(date);
      await obsidian.appendJournalLine(
        date,
        placeholderLine(time, id),
        section,
      );
      log.debug({ id, notePath }, "placeholder line written");
    }
    this.deps.queue.add([id]);
    log.debug({ id }, "jot queued for flush");
  }

  /** The owner reacting 🤝 on a squashed follower's own message: opting it out of the
   *  merge. Only takes effect while the jot is still pending; `unsquash` is the
   *  compare-and-swap that enforces that atomically, so a tap racing the leader's flush
   *  loses cleanly rather than double-posting the follower's text. */
  async optOutOfSquash(messageId: number): Promise<void> {
    const { repo, obsidian, notifier } = this.deps;
    const jot = await this.byMessage(messageId);
    if (!jot || jot.anchor === jot.id) return; // not a squashed follower, nothing to opt out of
    if (!(await repo.unsquash(jot.id))) {
      log.info(
        { jotId: jot.id },
        "merge opt-out too late — already folded into the leader",
      );
      await notifier.notify("🤝 too late — that one's already merged in.");
      return;
    }
    log.info(
      { jotId: jot.id, formerLeader: jot.anchor },
      "merge opt-out — jot pulled back into its own line",
    );
    await obsidian.ensureDailyNote(plainDate(jot.received_at));
    await obsidian.appendJournalLine(
      plainDate(jot.received_at),
      placeholderLine(jot.time, jot.id),
      jot.section,
    );
    await notifier.react(messageId, "✍");
  }

  /** Create-or-edit the one live status message for a jot. First call sends it and
   *  remembers the message id; later calls edit that same message in place, so the chat
   *  reads as a clean audit trail instead of a stream of notifications. `undo: true`
   *  attaches an undo button, `embed` the embed toggle; `retry`/`discard` attach the
   *  failure pair; otherwise any button is cleared. */
  async status(
    jotId: string,
    html: string,
    opts?: StatusButtons,
  ): Promise<void> {
    await this.showStatus(jotId, html, statusKeyboard(jotId, opts));
  }

  private async showStatus(
    jotId: string,
    html: string,
    keyboard: { inline_keyboard: readonly (readonly object[])[] },
  ): Promise<void> {
    const { repo, notifier } = this.deps;
    const existing = this.statusMsgs.get(jotId);
    const opts = { html: true, keyboard };
    if (existing) {
      try {
        await notifier.edit(existing, html, opts);
        log.debug({ jotId, messageId: existing }, "status edited");
        return;
      } catch (err) {
        log.warn(
          { jotId, messageId: existing, err },
          "status edit failed — sending a fresh one",
        );
      }
    }
    const messageId = await notifier.send(html, opts);
    this.statusMsgs.set(jotId, messageId);
    // Mapped to the jot too, so a reply to the status message edits the jot just like a
    // reply to the original message (e.g. the transcribed audio note).
    await repo.mapMessage(messageId, jotId);
    log.debug({ jotId, messageId }, "status message sent");
  }

  /** Delete a jot's live status message, if it has one. Best-effort: used on a squash to
   *  collapse any stray per-follower message into the leader's single confirmation. */
  async deleteStatus(jotId: string): Promise<void> {
    const messageId = this.statusMsgs.get(jotId);
    if (!messageId) return;
    this.statusMsgs.delete(jotId);
    await this.deps.repo.unmapMessage(messageId); // no stale reply-map to a gone message
    try {
      await this.deps.notifier.delete(messageId);
      log.info({ jotId, messageId }, "deleted stray status message (squash)");
    } catch (err) {
      log.warn({ jotId, messageId, err }, "failed to delete status message");
    }
  }

  /** Swap the intake reaction on a jot's message to reflect its outcome. */
  async react(jotId: string, state: JotOutcome): Promise<void> {
    const messageId = await this.deps.repo.messageForJot(jotId);
    if (!messageId) return;
    await this.deps.notifier.react(messageId, OUTCOME_EMOJI[state]);
  }

  /** Show both transcript versions on the jot's status message and wait for the owner to
   *  pick one. Times out to 'original' after 5 minutes so processing never stalls. */
  async awaitVoiceFix(
    jotId: string,
    original: string,
    proposed: string,
  ): Promise<VoiceFixChoice> {
    const html = [
      "<b>Original transcript:</b>",
      `<i>${escapeHtml(original)}</i>`,
      "",
      "<b>Proposed fix:</b>",
      `<i>${escapeHtml(proposed)}</i>`,
    ].join("\n");
    await this.showStatus(jotId, html, {
      inline_keyboard: [
        [
          { text: "📝 Use original", callback_data: `vf:o:${jotId}` },
          { text: "✨ Use fixed", callback_data: `vf:p:${jotId}` },
        ],
      ],
    });
    return new Promise<VoiceFixChoice>((resolve) => {
      this.voiceFixPending.set(jotId, resolve);
      setTimeout(
        () => {
          if (this.voiceFixPending.delete(jotId)) {
            log.info({ jotId }, "voice fix: timed out, using original");
            resolve("original");
          }
        },
        5 * 60 * 1000,
      );
    });
  }

  /** Claim the owner's pick. The returned call hands it to the waiting processor, so the
   *  view can answer the tap first; nothing comes back when no pick is pending. */
  pickVoiceFix(
    jotId: string,
    choice: VoiceFixChoice,
  ): (() => void) | undefined {
    const resolve = this.voiceFixPending.get(jotId);
    if (!resolve) {
      log.warn(
        { jotId },
        "voice fix: no pending choice (timed out or duplicate)",
      );
      return undefined;
    }
    this.voiceFixPending.delete(jotId);
    log.info({ jotId, choice }, "voice fix: user picked");
    return () => resolve(choice);
  }

  /** Put a jot back in the queue by hand: a squashed follower through its leader, whose
   *  line it shares. The reset skips a jot being processed right now, so a second tap, or
   *  a tap racing the retry pass, cannot queue it twice. */
  async retry(jot: Jot): Promise<RetryOutcome> {
    const target = await this.leaderOf(jot);
    if (!(await this.deps.repo.resetForRetry(target.id))) {
      log.warn(
        { jotId: jot.id, target: target.id, status: target.status },
        "retry refused: jot is being processed",
      );
      return "in-flight";
    }
    this.deps.queue.add([target.id]);
    return "queued";
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
      tilLog.error({ err, jotId }, "til card failed to send");
      return;
    }
    // Marked only once the card is out, so a failed send leaves the offer for a reprocess.
    await this.deps.repo.markTilOffered(jotId);
    tilLog.info({ jotId }, "til card sent");
  }

  async answerTil(
    jotId: string | undefined,
    accept: boolean,
  ): Promise<TilOutcome> {
    const { repo, obsidian } = this.deps;
    const jot = jotId ? await repo.getJot(jotId) : undefined;
    if (!jot || jot.status === "deleted") {
      tilLog.warn({ jotId }, "til card: jot is gone");
      return "gone";
    }
    if (!accept) {
      tilLog.info({ jotId }, "til declined, kept in the journal");
      return "kept";
    }
    const moved = await obsidian
      .moveToTil(jot.note_path, jot.anchor)
      .catch((err: unknown) => {
        tilLog.error(
          { err, jotId },
          "til move failed, line left in the journal",
        );
        return null;
      });
    if (moved === null) return "failed";
    if (moved === "no-line") {
      tilLog.warn(
        { jotId },
        "til accepted but the line is no longer in the note",
      );
      return "no-line";
    }
    if (moved === "no-heading") {
      tilLog.warn({ jotId }, "til accepted but the note has no TIL heading");
      return "no-heading";
    }
    // The section decides which heading a re-written line goes back under, so it follows
    // the line: the leader's, and every squashed follower sharing it.
    const followers = await repo.groupFollowers(jot.id);
    for (const j of [jot, ...followers])
      await repo.updateJot(j.id, { section: "til" });
    tilLog.info({ jotId }, "til accepted, line moved");
    return "moved";
  }
}
