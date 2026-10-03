import { findSection, stampCompletion } from "../../libs/note.ts";
import { collapse, escapeRe, fingerprint } from "../../libs/text.ts";
import { DATE_RE } from "../../libs/time.ts";
import type { Task, TaskDraft, TaskState, TaskType } from "./entity.ts";

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
  for (const field of line.matchAll(FIELD_RE))
    out.set(field[1]!.trim().toLowerCase(), field[2]!.trim());
  return out;
}

/** A field's value when it's a real calendar date, else null: the vault has at least one
 *  typo'd `[start::6-03-01]`, and a half-parsed date is worse than none. */
function dateField(fieldMap: Map<string, string>, key: string): string | null {
  const value = fieldMap.get(key);
  return value && DATE_RE.test(value) ? value : null;
}

function taskText(body: string, tag: string): string {
  return collapse(
    body
      .replace(FIELD_RE, "")
      .replace(LEGACY_DONE_RE, "")
      .replace(new RegExp(`${escapeRe(tag)}(?=\\s|$)`, "g"), ""),
  );
}

export function parseTaskLine(
  line: string,
  index: number,
  type: TaskType,
  tag: string,
): Task | null {
  const match = line.match(CHECKBOX_RE);
  if (!match) return null;
  const fieldMap = fields(line);
  const legacy = line.match(LEGACY_DONE_RE)?.[1] ?? null;
  return {
    index,
    line,
    fingerprint: fingerprint(line),
    type,
    state: STATE_BY_MARK[match[2] as Mark],
    text: taskText(match[3]!, tag),
    start: dateField(fieldMap, "start"),
    due: dateField(fieldMap, "due"),
    completion: dateField(fieldMap, "completion") ?? legacy,
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
  for (let row = section.headingIdx + 1; row < section.end; row++) {
    const task = parseTaskLine(lines[row]!, out.length, type, tag);
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
  for (let row = from; row < end; row++)
    if (/^\s*-\s/.test(lines[row]!)) bullets.push(row);
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
  let seen = 0;
  for (let row = section.headingIdx + 1; row < section.end; row++) {
    if (!CHECKBOX_RE.test(lines[row]!)) continue;
    if (seen++ !== index) continue;
    lines[row] = newLine;
    return lines.join("\n");
  }
  return null;
}

function skipBlank(lines: string[], from: number, end: number): number {
  let row = from;
  while (row < end && lines[row]!.trim() === "") row++;
  return row;
}
