import type { Habit, HabitField } from "../domain/habit/entity.ts";
import { findSection, stampCompletion } from "./note.ts";

// `[Pages read:: 0]` → key "Pages read", value "0". Global so we can walk every field.
const inlineFieldRe = /\[\s*([^\]:]+?)\s*::\s*([^\]]*?)\s*\]/g;

function habitField(line: string): HabitField | null {
  for (const m of line.matchAll(inlineFieldRe)) {
    if (m[1]!.trim().toLowerCase() === "completion") continue;
    return { key: m[1]!.trim(), value: m[2]!.trim() };
  }
  return null;
}

function habitLabel(rest: string, field: HabitField | null): string {
  if (field) return field.key;
  return rest
    .replace(inlineFieldRe, "")
    .replace(/#\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseHabits(note: string, heading = "Habits"): Habit[] {
  const lines = note.split("\n");
  const section = findSection(lines, heading);
  if (!section) return [];
  const out: Habit[] = [];
  for (let i = section.headingIdx + 1; i < section.end; i++) {
    const l = lines[i]!;
    const m = l.match(/^\s*-\s*\[( |x|X)\]\s*(.*)$/);
    if (!m) continue;
    const field = habitField(l);
    out.push({
      index: out.length,
      line: l,
      done: m[1]!.toLowerCase() === "x",
      label: habitLabel(m[2]!, field),
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
    out = out.replace(inlineFieldRe, (full, k) => {
      if (replaced || String(k).trim().toLowerCase() === "completion")
        return full;
      replaced = true;
      return `[${String(k).trim()}:: ${value}]`;
    });
  }
  return stampCompletion(out, date);
}

export function parseHabitRef(
  text: string,
): { date: string; index: number; digest: string } | null {
  const match = text.match(/hb:(\d{4}-\d{2}-\d{2}):(\d+):([0-9a-f]{8})/);
  if (!match) return null;
  return { date: match[1]!, index: Number(match[2]), digest: match[3]! };
}

export function isHabitsReviewed(note: string): boolean {
  const m = note.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return false;
  return /^habitsReviewed:\s*true\s*$/m.test(m[1]!);
}

export function isNumericValue(s: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(s.trim());
}
