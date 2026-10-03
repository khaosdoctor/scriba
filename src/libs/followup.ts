import {
  FOLLOWUP_QUESTIONS,
  type FollowupQuestion,
} from "../domain/rating/entity.ts";

export interface FollowupRef {
  question: FollowupQuestion;
  date: string;
}

export const FOLLOWUP_CODES: Record<FollowupQuestion, string> = {
  journal: "j",
  til: "t",
};

export function followupRef(question: FollowupQuestion, date: string): string {
  return `(fu:${FOLLOWUP_CODES[question]}:${date})`;
}

export function followupFromCode(
  code: string | undefined,
): FollowupQuestion | null {
  return (
    FOLLOWUP_QUESTIONS.find((question) => FOLLOWUP_CODES[question] === code) ??
    null
  );
}

export function parseFollowupRef(text: string): FollowupRef | null {
  const match = text.match(/\(fu:([a-z]):(\d{4}-\d{2}-\d{2})\)/);
  const question = followupFromCode(match?.[1]);
  return match && question ? { question, date: match[2]! } : null;
}
