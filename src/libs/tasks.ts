import { createHash } from "node:crypto";
import * as chrono from "chrono-node";
import type {
  Task,
  TaskDraft,
  TaskState,
  TaskType,
} from "../domain/task/entity.ts";
import { isDateLike } from "./links.ts";
import { findSection, stampCompletion } from "./note.ts";
import { escapeHtml, escapeRe } from "./text.ts";
import { DATE_RE, dateFromIso, plainDate } from "./time.ts";

export const DEFAULT_TASK_TYPE: TaskType = "personal";

export function isTaskType(v: unknown): v is TaskType {
  return v === "work" || v === "personal";
}

// `[due:: 2026-09-02]` → key "due", value "2026-09-02". The key class excludes brackets so
// a `[[wikilink]]` or a `[label](url)` inside the description can never look like a field.
const FIELD_RE = /\[\s*([^[\]:]+?)\s*::\s*([^\]]*?)\s*\]/g;
// The Tasks plugin's own done marker, on older rows only.
const LEGACY_DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const CHECKBOX_RE = /^(\s*-\s*)\[([ xX\-/])\]\s?(.*)$/;

type Mark = " " | "x" | "X" | "-" | "/";
const STATE_BY_MARK: Record<Mark, TaskState> = {
  " ": "open",
  x: "done",
  X: "done",
  "-": "cancelled",
  "/": "open", // in-progress in some themes; still something to do
};

function fields(line: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of line.matchAll(FIELD_RE))
    out.set(m[1]!.trim().toLowerCase(), m[2]!.trim());
  return out;
}

/** A field's value when it's a real calendar date, else null: the vault has at least one
 *  typo'd `[start::6-03-01]`, and a half-parsed date is worse than none. */
function dateField(f: Map<string, string>, key: string): string | null {
  const v = f.get(key);
  return v && DATE_RE.test(v) ? v : null;
}

export function fingerprint(line: string): string {
  return createHash("sha1").update(line).digest("hex").slice(0, 8);
}

function taskText(body: string, tag: string): string {
  return body
    .replace(FIELD_RE, "")
    .replace(LEGACY_DONE_RE, "")
    .replace(new RegExp(`${escapeRe(tag)}(?=\\s|$)`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTaskLine(
  line: string,
  index: number,
  type: TaskType,
  tag: string,
): Task | null {
  const match = line.match(CHECKBOX_RE);
  if (!match) return null;
  const f = fields(line);
  const legacy = line.match(LEGACY_DONE_RE)?.[1] ?? null;
  return {
    index,
    line,
    fingerprint: fingerprint(line),
    type,
    state: STATE_BY_MARK[match[2] as Mark],
    text: taskText(match[3]!, tag),
    start: dateField(f, "start"),
    due: dateField(f, "due"),
    completion: dateField(f, "completion") ?? legacy,
  };
}

export function parseTasks(
  note: string,
  heading: string,
  tag: string,
  type: TaskType,
): Task[] {
  const lines = note.split("\n");
  const section = findSection(lines, heading);
  if (!section) return [];
  const out: Task[] = [];
  for (let i = section.headingIdx + 1; i < section.end; i++) {
    const task = parseTaskLine(lines[i]!, out.length, type, tag);
    if (task) out.push(task);
  }
  return out;
}

export function renderTaskLine(
  draft: TaskDraft,
  tag: string,
  sourceDate: string,
): string {
  const start = draft.start ?? draft.due;
  const from = ` (from [[${sourceDate}]])`;
  const parts = [`- [ ] ${draft.description.trim()}${from}`, tag];
  if (start) parts.push(`[start:: ${start}]`);
  if (draft.due) parts.push(`[due:: ${draft.due}]`);
  return parts.join(" ");
}

export function completeTaskLine(line: string, date: string): string {
  const out = line
    .replace(/^(\s*-\s*)\[[ \-/]\]/, "$1[x]")
    .replace(/\s*\[\s*cancelled\s*::[^\]]*\]/gi, "");
  if (LEGACY_DONE_RE.test(out)) return out;
  return stampCompletion(out, date);
}

export function uncompleteTaskLine(line: string): string {
  return line
    .replace(/^(\s*-\s*)\[[xX]\]/, "$1[ ]")
    .replace(/\s*\[\s*completion\s*::[^\]]*\]/gi, "")
    .replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+$/, "");
}

export function insertTaskLine(
  note: string,
  heading: string,
  line: string,
  position: "top" | "bottom",
): string {
  const lines = note.split("\n");
  const section = findSection(lines, heading);
  if (!section) throw new Error(`no "${heading}" heading in the note`);
  const from = section.headingIdx + 1;
  const { end } = section;
  const bullets: number[] = [];
  for (let i = from; i < end; i++)
    if (/^\s*-\s/.test(lines[i]!)) bullets.push(i);
  const at = bullets.length
    ? position === "top"
      ? bullets[0]!
      : bullets[bullets.length - 1]! + 1
    : skipBlank(lines, from, end);
  lines.splice(at, 0, line);
  return lines.join("\n");
}

export function replaceTaskLineAt(
  note: string,
  heading: string,
  index: number,
  newLine: string,
): string | null {
  const lines = note.split("\n");
  const section = findSection(lines, heading);
  if (!section) return null;
  let n = 0;
  for (let i = section.headingIdx + 1; i < section.end; i++) {
    if (!CHECKBOX_RE.test(lines[i]!)) continue;
    if (n++ !== index) continue;
    lines[i] = newLine;
    return lines.join("\n");
  }
  return null;
}

function skipBlank(lines: string[], from: number, end: number): number {
  let i = from;
  while (i < end && lines[i]!.trim() === "") i++;
  return i;
}

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

function trimTail(s: string): string {
  let out = s.trim();
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

  for (const r of hits) {
    const date = plainDate(r.start.date().getTime());
    const cue = cueBefore(text, r.index);
    const span: [number, number] = [r.index, r.index + r.text.length];
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
    const [a, b] =
      unlabelled[0]!.date <= unlabelled[1]!.date
        ? [unlabelled[0]!, unlabelled[1]!]
        : [unlabelled[1]!, unlabelled[0]!];
    if (!start) {
      start = a.date;
      consumed.push(a.span);
    }
    if (!due) {
      due = b.date;
      consumed.push(b.span);
    }
  }

  if (start && !due) {
    due = start;
    start = null;
  }

  let description = text;
  for (const [s, e] of consumed.sort((x, y) => y[0] - x[0]))
    description = `${description.slice(0, s)} ${description.slice(e)}`;

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
  const s = text.trim();
  const lower = s.toLowerCase();
  if (!s) return undefined;
  if (["none", "clear", "no", "-", "remove", "off"].includes(lower))
    return null;
  if (DATE_RE.test(s)) return s;
  const hit = dateHits(s, dateFromIso(today))[0];
  return hit ? plainDate(hit.start.date().getTime()) : undefined;
}

function phraseDate(phrase: string | undefined, today: string): string | null {
  if (!phrase?.trim()) return null;
  return parseTaskDate(phrase, today) ?? null;
}

export function draftFromDetection(
  detected: {
    description: string;
    start?: string;
    due?: string;
    type?: string;
  },
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

export function effectiveStart(t: Task): string | null {
  return t.start ?? t.due;
}

export function weekBounds(date: string): [string, string] {
  const d = dateFromIso(date);
  const start = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() - d.getDay(),
  );
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 6,
  );
  return [plainDate(start.getTime()), plainDate(end.getTime())];
}

export function shiftDate(date: string, days: number): string {
  const d = dateFromIso(date);
  return plainDate(
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime(),
  );
}

export type TaskView =
  | "day"
  | "open"
  | "future"
  | "overdue"
  | "today"
  | "week"
  | "two"
  | "done";

export function filterTasks(
  tasks: Task[],
  view: TaskView,
  today = plainDate(),
): Task[] {
  if (view === "done") {
    return tasks
      .filter((t) => t.state === "done")
      .sort((a, b) => (b.completion ?? "").localeCompare(a.completion ?? ""));
  }
  const [weekStart, weekEnd] = weekBounds(today);
  const inWeek = (d: string | null) => !!d && d >= weekStart && d <= weekEnd;
  const twoWeeks = shiftDate(today, 14);
  const matches: Record<Exclude<TaskView, "done">, (task: Task) => boolean> = {
    day: (task) =>
      (!!task.due && task.due <= today) || effectiveStart(task) === today,
    open: () => true,
    future: (task) => !!task.due && task.due >= today,
    overdue: (task) => !!task.due && task.due < today,
    today: (task) => task.due === today || effectiveStart(task) === today,
    week: (task) => inWeek(task.due) || inWeek(effectiveStart(task)),
    two: (task) => !!task.due && task.due >= today && task.due <= twoWeeks,
  };
  const open = tasks.filter((task) => task.state === "open");
  const picked = open.filter(matches[view]);
  return picked.sort(
    (a, b) =>
      (a.due ?? "9999-99-99").localeCompare(b.due ?? "9999-99-99") ||
      (effectiveStart(a) ?? "").localeCompare(effectiveStart(b) ?? "") ||
      a.text.localeCompare(b.text),
  );
}

const STATE_ICON: Record<TaskState, string> = {
  open: "☐",
  done: "☑",
  cancelled: "⊘",
};

export const TYPE_LABEL: Record<TaskType, string> = {
  work: "🏢 Work",
  personal: "🏠 Personal",
};

export const VIEW_LABEL: Record<TaskView, string> = {
  day: "🌅 Today and overdue",
  open: "📋 All open tasks",
  future: "🔭 Open tasks ahead",
  overdue: "⏰ Overdue",
  today: "📅 Due today",
  week: "🗓 This week",
  two: "📆 Next two weeks",
  done: "✅ Done",
};

export function taskListLine(
  t: Task,
  n: number,
  today = plainDate(),
  max = 160,
): string {
  const late = t.state === "open" && t.due && t.due < today ? " ⚠️" : "";
  const dates =
    t.state === "done"
      ? t.completion
        ? ` · done ${t.completion}`
        : ""
      : t.due
        ? ` · due ${t.due}${late}`
        : "";
  const started =
    t.state === "open" && t.start && t.start !== t.due
      ? ` · starts ${t.start}`
      : "";
  const full = t.text || "(no description)";
  const text = full.length > max ? `${full.slice(0, max - 1)}…` : full;
  return `${n}. ${STATE_ICON[t.state]} ${escapeHtml(text)}${dates}${started} <i>${t.type}</i>`;
}

/** Button label for a task row: short enough to survive Telegram's button width. */
export function taskButtonLabel(t: Task, n: number, max = 34): string {
  const text = (t.text || "(no description)").replace(/\s+/g, " ");
  const body = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return `${STATE_ICON[t.state]} ${n}. ${body}`;
}

export function taskCard(draft: TaskDraft, header = "📝 New task"): string {
  return [
    header,
    "",
    `<b>${escapeHtml(draft.description || "(no description yet)")}</b>`,
    "",
    `Type: ${TYPE_LABEL[draft.type]}`,
    `Start: ${draft.start ?? draft.due ?? "—"}`,
    `Due: ${draft.due ?? "— <i>(needed)</i>"}`,
  ].join("\n");
}
