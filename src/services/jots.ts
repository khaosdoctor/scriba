import type { JotRepository } from "../data/repositories/jots.ts";
import type { ObsidianClient } from "../data/repositories/notes.ts";
import {
  type Jot,
  type JotKind,
  type JotSection,
  SQUASHABLE_KINDS,
} from "../domain/jot/entity.ts";
import {
  isFollower,
  placeholderLine,
  stripTilPrefix,
  withinSquashWindow,
} from "../domain/jot/rules.ts";
import type { IntakeInput } from "../domain/jot/structures.ts";
import { type StatusButtons, statusKeyboard } from "../libs/jot.ts";
import { type Keyboard, keyboard } from "../libs/keyboard.ts";
import { logger } from "../libs/log.ts";
import { PendingDecisions } from "../libs/pending.ts";
import type { FlushQueue } from "../libs/queue.ts";
import { clipUpdate, escapeHtml, shortId } from "../libs/text.ts";
import { dayBounds, plainDate, plainTime } from "../libs/time.ts";
import type { Notifier } from "./notifier.ts";

const log = logger("bot");
const tilLog = logger("til-flow");

/** Cap on the quoted jot. Escaping can grow a character to five, so this keeps the card
 *  well inside Telegram's 4096 whatever the jot holds. */
const QUOTE_CHARS = 600;

export const TIL_NS = "ti";

export const VOICEFIX_NS = "vf";

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

export interface JotDeps {
  repo: JotRepository;
  obsidian: ObsidianClient;
  notifier: Notifier;
  queue: Pick<FlushQueue, "add">;
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
  private statusMsgs = new Map<string, number>();
  private voiceFixPending = new PendingDecisions<VoiceFixChoice>({
    clearAndUnref: false,
  });

  constructor(private deps: JotDeps) {}

  recent(limit: number): Promise<Jot[]> {
    return this.deps.repo.recentJots(limit);
  }

  get(id: string): Promise<Jot | undefined> {
    return this.deps.repo.getJot(id);
  }

  async leaderOf(jot: Jot): Promise<Jot> {
    if (!isFollower(jot)) return jot;
    const leader = await this.deps.repo.getJot(jot.anchor);
    return leader && leader.status !== "deleted" ? leader : jot;
  }

  async byMessage(messageId: number): Promise<Jot | undefined> {
    const id = await this.deps.repo.jotForMessage(messageId);
    return id ? this.deps.repo.getJot(id) : undefined;
  }

  async intake(input: IntakeInput): Promise<void> {
    const { repo, obsidian, notifier } = this.deps;
    const epochMs =
      input.day && input.day !== plainDate(input.sentAt)
        ? dayBounds(input.day)[1] - 1000
        : input.sentAt;
    const id = shortId();
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

    let anchor = id;
    let squashed = false;
    // A follow-up answer (`day`) is stamped with the day's last second, so two of them would
    // always look like one burst: they are deliberate entries and never squash.
    if (
      !input.day &&
      (SQUASHABLE_KINDS as readonly JotKind[]).includes(input.kind)
    ) {
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
    if (!jot || !isFollower(jot)) return; // not a squashed follower, nothing to opt out of
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
    keyboard: Keyboard,
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
    await this.showStatus(
      jotId,
      html,
      keyboard([
        [
          ["📝 Use original", `${VOICEFIX_NS}:o:${jotId}`],
          ["✨ Use fixed", `${VOICEFIX_NS}:p:${jotId}`],
        ],
      ]),
    );
    return this.voiceFixPending.wait(jotId, 5 * 60 * 1000, "original", () =>
      log.info({ jotId }, "voice fix: timed out, using original"),
    );
  }

  pickVoiceFix(
    jotId: string,
    choice: VoiceFixChoice,
  ): (() => void) | undefined {
    const resolve = this.voiceFixPending.take(jotId);
    if (!resolve) {
      log.warn(
        { jotId },
        "voice fix: no pending choice (timed out or duplicate)",
      );
      return undefined;
    }
    log.info({ jotId, choice }, "voice fix: user picked");
    return () => resolve(choice);
  }

  async retry(jot: Jot): Promise<"queued" | "in-flight"> {
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

  async askEdit(id: string): Promise<void> {
    const messageId = await this.deps.notifier.send(
      `✏️ Reply to this message with your edit for ${id} (or "delete" to remove it).`,
      { forceReply: true },
    );
    await this.deps.repo.mapMessage(messageId, id);
  }

  async askTil(jotId: string, text: string): Promise<void> {
    try {
      await this.deps.notifier.send(
        `💡 That sounds like a TIL. Move this to TIL?\n<blockquote>${escapeHtml(clipUpdate(text, QUOTE_CHARS))}</blockquote>`,
        {
          html: true,
          keyboard: keyboard([
            [
              ["✅ Move to TIL", `${TIL_NS}:y:${jotId}`],
              ["🚫 Keep in Journal", `${TIL_NS}:n:${jotId}`],
            ],
          ]),
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
    for (const member of [jot, ...followers])
      await repo.updateJot(member.id, { section: "til" });
    tilLog.info({ jotId }, "til accepted, line moved");
    return "moved";
  }
}
