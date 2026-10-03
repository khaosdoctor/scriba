import {
  findSection,
  frontmatterBlock,
  stampCompletion,
} from "../../libs/note.ts";
import { collapse } from "../../libs/text.ts";
import type { Habit, HabitField } from "./entity.ts";

// `[Pages read:: 0]` → key "Pages read", value "0". Global so we can walk every field.
const inlineFieldRe = /\[\s*([^\]:]+?)\s*::\s*([^\]]*?)\s*\]/g;

function habitField(line: string): HabitField | null {
  for (const match of line.matchAll(inlineFieldRe)) {
    if (match[1]!.trim().toLowerCase() === "completion") continue;
    return { key: match[1]!.trim(), value: match[2]!.trim() };
  }
  return null;
}

function habitLabel(rest: string, field: HabitField | null): string {
  if (field) return field.key;
  return collapse(rest.replace(inlineFieldRe, "").replace(/#\S+/g, ""));
}

export function parseHabits(note: string, heading = "Habits"): Habit[] {
  const lines = note.split("\n");
  const section = findSection(lines, heading);
  if (!section) return [];
  const out: Habit[] = [];
  for (let idx = section.headingIdx + 1; idx < section.end; idx++) {
    const line = lines[idx]!;
    const match = line.match(/^\s*-\s*\[( |x|X)\]\s*(.*)$/);
    if (!match) continue;
    const field = habitField(line);
    out.push({
      index: out.length,
      line,
      done: match[1]!.toLowerCase() === "x",
      label: habitLabel(match[2]!, field),
      field,
    });
  }
  return out;
}

export function completeHabitLine(
  line: string,
  date: string,
  value?: string,
): string {
  let out = line.replace(/^(\s*-\s*)\[\s\]/, "$1[x]");
  if (value !== undefined) {
    let replaced = false;
    out = out.replace(inlineFieldRe, (full, key) => {
      if (replaced || String(key).trim().toLowerCase() === "completion")
        return full;
      replaced = true;
      return `[${String(key).trim()}:: ${value}]`;
    });
  }
  return stampCompletion(out, date);
}

export function isHabitsReviewed(note: string): boolean {
  const frontmatter = frontmatterBlock(note);
  if (frontmatter === undefined) return false;
  return /^habitsReviewed:\s*true\s*$/m.test(frontmatter);
}

export function isNumericValue(text: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(text.trim());
}
