import type { ObsidianClient } from "../data/repositories/notes.ts";
import type { RatingRepository } from "../data/repositories/ratings.ts";
import type { SettingsRepository } from "../data/repositories/settings.ts";
import { logger } from "../libs/log.ts";
import { sectionHasContent } from "../libs/note.ts";
import { ratingDay } from "../libs/time.ts";
import type { Notifier } from "./notifier.ts";

const log = { rating: logger("rating"), followup: logger("followup") };

export const RATING_NS = "rate";

export const FOLLOWUP_NS = "fu";

export interface RatingDeps {
  repo: SettingsRepository;
  ratings: RatingRepository;
  obsidian: Pick<ObsidianClient, "setDailyRating" | "readDailyNote">;
  notifier: Pick<Notifier, "send" | "delete">;
  ratingTime: string;
  headings: { journal: string; til: string };
}

export type RateOutcome =
  | { kind: "saved"; rating: number }
  | { kind: "already"; current: number };

export const FOLLOWUP_QUESTIONS = ["journal", "til"] as const;
export type FollowupQuestion = (typeof FOLLOWUP_QUESTIONS)[number];

export interface FollowupRef {
  question: FollowupQuestion;
  date: string;
}

const PROMPTS: Record<FollowupQuestion, string> = {
  journal: "📝 One line for the day?",
  til: "💡 Learned anything today?",
};

const FOLLOWUP_CODES: Record<FollowupQuestion, string> = {
  journal: "j",
  til: "t",
};

export function followupQuestions(
  note: string | null,
  headings: { journal: string; til: string },
  after?: FollowupQuestion,
): FollowupQuestion[] {
  const empty: Record<FollowupQuestion, boolean> = {
    journal: !note || !sectionHasContent(note, headings.journal),
    til: !note || !sectionHasContent(note, headings.til),
  };
  const from = after ? FOLLOWUP_QUESTIONS.indexOf(after) + 1 : 0;
  return FOLLOWUP_QUESTIONS.slice(from).filter((q) => empty[q]);
}

export function followupRef(question: FollowupQuestion, date: string): string {
  return `(fu:${FOLLOWUP_CODES[question]}:${date})`;
}

export function followupFromCode(
  code: string | undefined,
): FollowupQuestion | null {
  return FOLLOWUP_QUESTIONS.find((q) => FOLLOWUP_CODES[q] === code) ?? null;
}

export class RatingService {
  /** Prompts already skipped, so a double tap asks the next question once. Forgotten on
   *  restart, which only loses the guard for a prompt that was live then. */
  private skipped = new Set<number>();

  constructor(private deps: RatingDeps) {}

  async nightly(): Promise<void> {
    const { repo, ratingTime } = this.deps;
    if (!(await repo.getSetting("nightlyRating"))) {
      log.rating.info("nightly rating is off, skipping");
      return;
    }
    const at = await repo.ratingTime(ratingTime);
    await this.prompt(ratingDay(at));
  }

  async prompt(date: string): Promise<void> {
    log.rating.info({ date }, "prompting for daily rating");
    const button = (n: number) => ({
      text: String(n),
      callback_data: `${RATING_NS}:${date}:${n}`,
    });
    await this.deps.notifier.send(`📊 How was ${date}? Rate it 1–10:`, {
      keyboard: {
        inline_keyboard: [
          [1, 2, 3, 4, 5].map(button),
          [6, 7, 8, 9, 10].map(button),
        ],
      },
    });
  }

  /** Record `rating` for `date`. The DB claim makes it write-once; a failed frontmatter
   *  write releases the claim so the tap can be retried. */
  async rate(date: string, rating: number): Promise<RateOutcome> {
    const { ratings, obsidian } = this.deps;
    const { recorded, current } = await ratings.recordRating(date, rating);
    if (!recorded) {
      log.rating.info(
        { date, attempted: rating, current },
        "rating tap ignored: day already rated",
      );
      return { kind: "already", current };
    }
    log.rating.info({ date, rating }, "recorded rating, writing frontmatter");
    try {
      await obsidian.setDailyRating(date, rating);
    } catch (e) {
      log.rating.error(
        { err: e, date, rating },
        "frontmatter write failed, releasing rating for retry",
      );
      await ratings.clearRating(date);
      throw e;
    }
    log.rating.info({ date, rating }, "daily rating saved");
    return { kind: "saved", rating };
  }

  async startFollowup(date: string): Promise<void> {
    if (!(await this.deps.repo.getSetting("nightlyFollowup"))) {
      log.followup.info({ date }, "follow-up is off, not asking");
      return;
    }
    log.followup.info({ date }, "starting follow-up");
    await this.ask(date);
  }

  async answerFollowup(
    ref: FollowupRef,
    answer: string,
    promptId: number,
    jot: (date: string, text: string) => Promise<void>,
  ): Promise<void> {
    log.followup.info({ ...ref }, "follow-up answered");
    await jot(ref.date, ref.question === "til" ? `TIL: ${answer}` : answer);
    await this.drop(promptId);
    await this.ask(ref.date, ref.question);
  }

  /** Claims a Skip tap on `messageId`. Called before any await, so a double tap is refused
   *  here and never reaches `skipFollowup` twice. */
  claimSkip(
    question: FollowupQuestion,
    date: string,
    messageId: number,
  ): boolean {
    if (this.skipped.has(messageId)) {
      log.followup.info(
        { date, question },
        "follow-up tap ignored: already skipped",
      );
      return false;
    }
    this.skipped.add(messageId);
    log.followup.info({ date, question }, "follow-up skipped");
    return true;
  }

  async skipFollowup(
    question: FollowupQuestion,
    date: string,
    messageId: number,
  ): Promise<void> {
    await this.drop(messageId);
    await this.ask(date, question);
  }

  private async ask(date: string, after?: FollowupQuestion): Promise<void> {
    const { obsidian, headings, notifier } = this.deps;
    const daily = await obsidian.readDailyNote(date);
    const [question] = followupQuestions(
      daily?.content ?? null,
      headings,
      after,
    );
    if (!question) {
      log.followup.info({ date, after }, "follow-up done: nothing left to ask");
      return;
    }
    log.followup.info({ date, question }, "asking follow-up question");
    await notifier.send(
      `${PROMPTS[question]} Reply to this message, or skip.\n${followupRef(question, date)}`,
      {
        keyboard: {
          inline_keyboard: [
            [
              {
                text: "⏭ Skip",
                callback_data: `${FOLLOWUP_NS}:${FOLLOWUP_CODES[question]}:${date}`,
              },
            ],
          ],
        },
      },
    );
  }

  private async drop(messageId: number): Promise<void> {
    await this.deps.notifier.delete(messageId).catch(() => {});
  }
}
