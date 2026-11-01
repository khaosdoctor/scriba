import type { JotRepository } from "../data/repositories/jots.ts";
import type { ObsidianClient } from "../data/repositories/notes.ts";
import type { SettingsRepository } from "../data/repositories/settings.ts";
import type { Jot } from "../domain/jot/entity.ts";
import {
  backfilledTime,
  entryContent,
  isEditableJot,
  jotDay,
  journalLine,
  sourcePatch,
  stripJournalLine,
} from "../domain/jot/rules.ts";
import {
  type BackfillGuess,
  backfillCard,
  backfillGuess,
  calendarRows,
  dayLabel,
  movedKeyboard,
  randomDaytime,
} from "../libs/backfill.ts";
import { type Keyboard, keyboard } from "../libs/keyboard.ts";
import { logger } from "../libs/log.ts";
import { clipUpdate, escapeHtml } from "../libs/text.ts";
import { plainDate, plainTime } from "../libs/time.ts";
import type { Enricher } from "./enrich.ts";
import type { Notifier } from "./notifier.ts";

const log = logger("backfill");

/** Escaping can grow a character to five, so this keeps the card inside Telegram's cap. */
const QUOTE_CHARS = 600;

export interface BackfillDeps {
  repo: Pick<
    JotRepository,
    | "getJot"
    | "groupFollowers"
    | "updateJot"
    | "backfillOffered"
    | "markBackfillOffered"
  >;
  settings: Pick<SettingsRepository, "getSetting">;
  obsidian: Pick<ObsidianClient, "dailyPath" | "moveToDay">;
  enricher: Pick<Enricher, "confirmPastDay">;
  notifier: Pick<Notifier, "send">;
  now?: () => number;
  random?: () => number;
}

export type MoveOutcome = "moved" | "gone" | "busy" | "no-line" | "failed";

export interface PastDay extends BackfillGuess {
  phrase: string;
  /** The enricher's rewrite without the words for when, filed on a move. */
  text?: string;
}

const quote = (text: string) =>
  `<blockquote>${escapeHtml(clipUpdate(text, QUOTE_CHARS))}</blockquote>`;

export class BackfillService {
  constructor(private deps: BackfillDeps) {}

  private today(): string {
    return plainDate((this.deps.now ?? Date.now)());
  }

  /** Where a just-enriched jot seems to belong, or null when it isn't a question worth
   *  asking: the switch is off, the jot isn't in today's note (a follow-up filed under
   *  another day, or an old jot being reprocessed), or it was already asked about. */
  async detect(
    jot: Jot,
    phrase: string | undefined,
    source: string,
    pastText?: string,
  ): Promise<PastDay | null> {
    if (!phrase) return null;
    const guess = backfillGuess(phrase, source, jotDay(jot));
    if (!guess) {
      log.debug({ id: jot.id, phrase }, "past words name no earlier day");
      return null;
    }
    if (!(await this.deps.settings.getSetting("backfillDetection"))) {
      log.debug({ id: jot.id }, "backfill detection off");
      return null;
    }
    if (jotDay(jot) !== this.today()) {
      log.debug({ id: jot.id }, "backfill: jot isn't in today's note");
      return null;
    }
    if (await this.deps.repo.backfillOffered(jot.id)) {
      log.info({ id: jot.id }, "backfill: already asked, not asking again");
      return null;
    }
    log.info(
      { id: jot.id, phrase, ...guess },
      "backfill: entry about a past day",
    );
    return { ...guess, phrase, text: pastText };
  }

  /** Moves the entry on its own when the words name one day and a second model agrees;
   *  anything less sends the card. Runs after the line is written, like the TIL card. */
  async offer(jot: Jot, past: PastDay, linked: string): Promise<void> {
    if (past.text)
      await this.deps.repo.updateJot(jot.id, { past_text: past.text });
    const text = past.text ?? linked;
    const sure =
      past.specific &&
      (await this.deps.enricher.confirmPastDay(text, past.phrase));
    const moved = sure && (await this.move(jot.id, past.date)) === "moved";
    try {
      if (moved) {
        log.info(
          { id: jot.id, date: past.date },
          "backfill: moved without asking",
        );
        await this.deps.notifier.send(
          `🗓 Moved to ${dayLabel(past.date)} (“${escapeHtml(past.phrase)}”)\n${quote(text)}`,
          { html: true, keyboard: movedKeyboard(jot.id) },
        );
      }
      if (!moved) {
        log.info({ id: jot.id, date: past.date, sure }, "backfill: asking");
        await this.deps.notifier.send(
          `🗓 Did this happen on ${dayLabel(past.date)}? (“${escapeHtml(past.phrase)}”)\n${quote(text)}`,
          { html: true, keyboard: backfillCard(jot.id, past.date) },
        );
      }
    } catch (err) {
      log.error({ err, id: jot.id }, "backfill card failed to send");
      if (!moved) return; // left unmarked, so a reprocess can ask again
    }
    await this.deps.repo.markBackfillOffered(jot.id);
  }

  /** Move a jot's line (and any squashed followers riding on it) to `date`'s note, as the
   *  enricher's rewrite when there is one, at a made-up daytime clock that says when it
   *  was written. Going back to the day it was written restores the arrival time and the
   *  words the rewrite replaced. */
  async move(jotId: string | undefined, date: string): Promise<MoveOutcome> {
    const { repo, obsidian } = this.deps;
    const jot = jotId ? await repo.getJot(jotId) : undefined;
    if (!jot || jot.status === "deleted") {
      log.warn({ jotId }, "backfill move: jot is gone");
      return "gone";
    }
    if (!isEditableJot(jot.status) || jotDay(jot) === date) {
      log.warn({ jotId, status: jot.status, date }, "backfill move refused");
      return "busy";
    }
    const writtenOn = plainDate(jot.received_at);
    const home = date === writtenOn;
    const backfilled = backfilledTime(
      randomDaytime(this.deps.random),
      writtenOn,
    );
    const stamp = (member: Jot) =>
      home ? plainTime(member.received_at) : backfilled;
    // Going home puts back the words the first move replaced; leaving files the rewrite.
    const text = home ? jot.pre_move_text : jot.past_text;
    const kept: { words?: string } = {};
    const result = await obsidian
      .moveToDay(jot.note_path, jot.anchor, date, jot.section, (line) => {
        kept.words = stripJournalLine(line, jot.time);
        return journalLine(
          stamp(jot),
          text ? entryContent(jot, text) : kept.words,
          jot.anchor,
          jot.section,
        );
      })
      .catch((err: unknown) => {
        log.error({ err, jotId, date }, "backfill move failed");
        return "failed" as const;
      });
    if (result !== "moved") return result;
    const notePath = obsidian.dailyPath(date);
    const followers = await repo.groupFollowers(jot.id);
    for (const member of [jot, ...followers])
      await repo.updateJot(member.id, {
        note_path: notePath,
        time: stamp(member),
      });
    // The filed words become the jot's source, so a reprocess keeps them.
    const patch = text && !followers.length && sourcePatch(jot, text);
    if (patch) await repo.updateJot(jot.id, patch);
    if (home && jot.pre_move_text)
      await repo.updateJot(jot.id, { pre_move_text: null });
    if (!home && text && !jot.pre_move_text)
      await repo.updateJot(jot.id, { pre_move_text: kept.words });
    log.info({ jotId, from: jotDay(jot), to: date }, "backfill: jot moved");
    return "moved";
  }

  /** Put a moved jot back on the day it was written. */
  async undo(jotId: string | undefined): Promise<MoveOutcome> {
    const jot = jotId ? await this.deps.repo.getJot(jotId) : undefined;
    if (!jot) return "gone";
    log.info({ jotId }, "backfill: undoing a move");
    return this.move(jotId, plainDate(jot.received_at));
  }

  calendar(jotId: string, month: string): Keyboard {
    return keyboard(calendarRows(jotId, month, this.today()));
  }

  isPast(date: string): boolean {
    return date < this.today();
  }
}
