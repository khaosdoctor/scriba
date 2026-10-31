import type { JotRepository } from "../data/repositories/jots.ts";
import type { ObsidianClient } from "../data/repositories/notes.ts";
import type { SettingsRepository } from "../data/repositories/settings.ts";
import type { Jot } from "../domain/jot/entity.ts";
import {
  arrivalTime,
  backfilledTime,
  isEditableJot,
  jotDay,
  journalLine,
  stripJournalLine,
} from "../domain/jot/rules.ts";
import {
  type BackfillGuess,
  backfillCard,
  backfillGuess,
  calendarRows,
  dayLabel,
  undoMoveKeyboard,
} from "../libs/backfill.ts";
import { type Keyboard, keyboard } from "../libs/keyboard.ts";
import { logger } from "../libs/log.ts";
import { clipUpdate, escapeHtml } from "../libs/text.ts";
import { plainDate } from "../libs/time.ts";
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
}

export type MoveOutcome = "moved" | "gone" | "busy" | "no-line" | "failed";

export interface PastDay extends BackfillGuess {
  phrase: string;
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
    return { ...guess, phrase };
  }

  /** Moves the entry on its own when the words name one day and a second model agrees;
   *  anything less sends the card. Runs after the line is written, like the TIL card. */
  async offer(jot: Jot, past: PastDay, text: string): Promise<void> {
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
          { html: true, keyboard: undoMoveKeyboard(jot.id) },
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

  /** Move a jot's line (and any squashed followers riding on it) to `date`'s note. The
   *  time stamp says when it was written unless it is going back to that day. */
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
    const stamp = (time: string) =>
      date === writtenOn ? arrivalTime(time) : backfilledTime(time, writtenOn);
    const result = await obsidian
      .moveToDay(jot.note_path, jot.anchor, date, jot.section, (line) =>
        journalLine(
          stamp(jot.time),
          stripJournalLine(line, jot.time),
          jot.anchor,
          jot.section,
        ),
      )
      .catch((err: unknown) => {
        log.error({ err, jotId, date }, "backfill move failed");
        return "failed" as const;
      });
    if (result !== "moved") return result;
    const notePath = obsidian.dailyPath(date);
    for (const member of [jot, ...(await repo.groupFollowers(jot.id))])
      await repo.updateJot(member.id, {
        note_path: notePath,
        time: stamp(member.time),
      });
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
