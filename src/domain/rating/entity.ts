import { z } from "zod";
import { sectionHasContent } from "../../libs/note.ts";
import { parseClockTime, plainDate, previousDate } from "../../libs/time.ts";

export const RatingSchema = z.coerce.number().int().min(1).max(10);

export const FOLLOWUP_QUESTIONS = ["journal", "til"] as const;
export type FollowupQuestion = (typeof FOLLOWUP_QUESTIONS)[number];

export function ratingDay(time: string, now: number = Date.now()): string {
  const hour = Number(parseClockTime(time)!.slice(0, 2));
  return hour < 12 ? previousDate(now) : plainDate(now);
}

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
  return FOLLOWUP_QUESTIONS.slice(from).filter((question) => empty[question]);
}
