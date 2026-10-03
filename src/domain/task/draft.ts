import * as chrono from "chrono-node";
import { isDateLike } from "../../libs/links.ts";
import { DATE_RE, dateFromIso, plainDate } from "../../libs/time.ts";
import { DEFAULT_TASK_TYPE, type TaskDraft, type TaskType } from "./entity.ts";
import type { DetectedTask } from "./structures.ts";

const LOCALES = [chrono.en.casual, chrono.pt.casual, chrono.sv.casual];

const START_CUES = [
  "start",
  "starts",
  "starting",
  "begin",
  "begins",
  "beginning",
  "from",
  // pt / sv
  "começa",
  "comeca",
  "começo",
  "comeco",
  "iniciar",
  "início",
  "inicio",
  "desde",
  "börjar",
  "borjar",
  "från",
  "fran",
];
const DUE_CUES = [
  "due",
  "by",
  "deadline",
  "until",
  "till",
  "before",
  "end",
  "ends",
  "ending",
  "finish",
  "finishes",
  "for",
  // pt / sv
  "até",
  "ate",
  "prazo",
  "vence",
  "entregar",
  "terminar",
  "senast",
  "till",
  "innan",
];
/** Phrases that mean "this one is work". Deliberately narrow: a bare "work" is a verb as
 *  often as a category ("work on the guitar"), and the type toggle is one tap. */
const WORK_CUE =
  /(^|\s)(for work|at work|work task|work-related|work related|@work|#work|job)(\s|$|[.,;!?])/i;
const PERSONAL_CUE =
  /(^|\s)(personal|at home|@personal|#personal)(\s|$|[.,;!?])/i;
// `\b` is ASCII-only in JS, so it doesn't close a word ending in "é" or "å": the
// boundaries here are Unicode letter/digit lookarounds instead, or "até" and "på" would
// never be recognised as the filler they are.
const TAIL_FILLER =
  /[\s,.;:—-]*(?<![\p{L}\p{N}])(by|due|on|at|in|from|starting|start|starts|begin|begins|until|till|before|the|end|ends|of|for|and|then|to|até|ate|para|pra|em|na|no|de|do|da|dia|que|senast|innan|på|pa|den|i)(?![\p{L}\p{N}])[\s,.;:—-]*$/iu;

function dateHits(text: string, ref: Date): chrono.ParsedResult[] {
  for (const parser of LOCALES) {
    const hits = parser
      .parse(text, ref, { forwardDate: true })
      .filter(isDateLike);
    if (hits.length) return hits;
  }
  return [];
}

function cueBefore(text: string, index: number): "start" | "due" | null {
  const before = text.slice(Math.max(0, index - 16), index).toLowerCase();
  // Unicode-aware: the cue may be "até" or "från", whose last letter [a-z] doesn't match.
  const word = before.match(/(\p{L}+)[\s,:-]*$/u)?.[1];
  if (!word) return null;
  if (START_CUES.includes(word)) return "start";
  if (DUE_CUES.includes(word)) return "due";
  return null;
}

function trimTail(text: string): string {
  let out = text.trim();
  for (;;) {
    const next = out.replace(TAIL_FILLER, "").trim();
    if (next === out) return out.replace(/[\s,;:]+$/, "").trim();
    out = next;
  }
}

export function parseTaskDraft(text: string, today = plainDate()): TaskDraft {
  const ref = dateFromIso(today);
  const hits = dateHits(text, ref);

  let start: string | null = null;
  let due: string | null = null;
  const consumed: [number, number][] = [];
  const unlabelled: { date: string; span: [number, number] }[] = [];

  for (const hit of hits) {
    const date = plainDate(hit.start.date().getTime());
    const cue = cueBefore(text, hit.index);
    const span: [number, number] = [hit.index, hit.index + hit.text.length];
    if (cue === "start" && !start) {
      start = date;
      consumed.push(span);
    } else if (cue === "due" && !due) {
      due = date;
      consumed.push(span);
    } else if (!cue) {
      unlabelled.push({ date, span });
    }
  }
  if (unlabelled.length === 1 && !due) {
    due = unlabelled[0]!.date;
    consumed.push(unlabelled[0]!.span);
  } else if (unlabelled.length >= 2) {
    const [earlier, later] =
      unlabelled[0]!.date <= unlabelled[1]!.date
        ? [unlabelled[0]!, unlabelled[1]!]
        : [unlabelled[1]!, unlabelled[0]!];
    if (!start) {
      start = earlier.date;
      consumed.push(earlier.span);
    }
    if (!due) {
      due = later.date;
      consumed.push(later.span);
    }
  }

  if (start && !due) {
    due = start;
    start = null;
  }

  let description = text;
  for (const [from, to] of consumed.sort((left, right) => right[0] - left[0]))
    description = `${description.slice(0, from)} ${description.slice(to)}`;

  const type: TaskType =
    WORK_CUE.test(text) && !PERSONAL_CUE.test(text)
      ? "work"
      : DEFAULT_TASK_TYPE;
  description = description
    .replace(WORK_CUE, " ")
    .replace(PERSONAL_CUE, " ")
    .replace(/\s+/g, " ");

  return { description: trimTail(description), type, start, due };
}

export function parseTaskDate(
  text: string,
  today = plainDate(),
): string | null | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return undefined;
  if (["none", "clear", "no", "-", "remove", "off"].includes(lower))
    return null;
  if (DATE_RE.test(trimmed)) return trimmed;
  const hit = dateHits(trimmed, dateFromIso(today))[0];
  return hit ? plainDate(hit.start.date().getTime()) : undefined;
}

function phraseDate(phrase: string | undefined, today: string): string | null {
  if (!phrase?.trim()) return null;
  return parseTaskDate(phrase, today) ?? null;
}

export function draftFromDetection(
  detected: DetectedTask,
  jotDate: string,
): TaskDraft {
  const base = parseTaskDraft(detected.description, jotDate);
  let start = phraseDate(detected.start, jotDate) ?? base.start;
  let due = phraseDate(detected.due, jotDate) ?? base.due;
  if (!due && start) {
    due = start;
    start = null;
  }
  return {
    description: base.description || detected.description.trim(),
    type: detected.type === "work" ? "work" : base.type,
    start,
    due,
  };
}
