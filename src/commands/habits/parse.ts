/**
 * Pure, dependency-free habit helpers. Deterministic, token-free — unit-tested in
 * parse.test.ts. No network or side effects (same discipline as core.ts, kept here so all
 * the habit code lives in one folder).
 *
 * A habit is a checklist bullet under the `## Habits` heading:
 *   - [ ] Practiced music #meta/habits/music              (yes/no)
 *   - [ ] [Pages read:: 0] #meta/habits/reading           (has a value to fill in)
 *   - [x] Exercised … #meta/habits/exercise [completion:: 2026-06-22]   (done)
 * An inline field is `[Key:: value]`; the `completion` field is stamped on done and is
 * never treated as the habit's own value.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One inline `[key:: value]` field. */
export interface HabitField { key: string; value: string; }
export interface Habit {
  index: number; // position among habit bullets, stable regardless of check state
  line: string; // the full raw bullet line
  done: boolean; // `- [x]`
  label: string; // human prompt: the field key for value habits, else the bare text
  field: HabitField | null; // non-completion inline field, or null ⇒ yes/no habit
}

// `[Pages read:: 0]` → key "Pages read", value "0". Global so we can walk every field.
const inlineFieldRe = /\[\s*([^\]:]+?)\s*::\s*([^\]]*?)\s*\]/g;

/** The habit's own inline field (the first non-completion `[key:: value]`), or null. */
function habitField(line: string): HabitField | null {
  for (const m of line.matchAll(inlineFieldRe)) {
    if (m[1]!.trim().toLowerCase() === "completion") continue;
    return { key: m[1]!.trim(), value: m[2]!.trim() };
  }
  return null;
}

/** Prompt label: the field key for value habits, else the text minus fields and #tags. */
function habitLabel(rest: string, field: HabitField | null): string {
  if (field) return field.key;
  return rest
    .replace(inlineFieldRe, "")
    .replace(/#\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse the checklist bullets under the `## <heading>` section into ordered habits. */
export function parseHabits(note: string, heading = "Habits"): Habit[] {
  const lines = note.split("\n");
  const headingRe = new RegExp(`^#{1,6}\\s+${escapeRe(heading)}\\s*$`);
  const headingIdx = lines.findIndex((l) => headingRe.test(l));
  if (headingIdx === -1) return [];
  const out: Habit[] = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^#{1,6}\s/.test(l)) break; // next heading ends the section
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

/** Mark a habit line done: tick the box, fill the inline field value (when given), and
 *  stamp `[completion:: date]` (once). Idempotent on an already-completed line. */
export function completeHabitLine(line: string, date: string, value?: string): string {
  let out = line.replace(/^(\s*-\s*)\[\s\]/, "$1[x]");
  if (value !== undefined) {
    let replaced = false;
    out = out.replace(inlineFieldRe, (full, k) => {
      if (replaced || String(k).trim().toLowerCase() === "completion") return full;
      replaced = true;
      return `[${String(k).trim()}:: ${value}]`;
    });
  }
  if (!/\[\s*completion\s*::/i.test(out)) out = `${out.replace(/\s*$/, "")} [completion:: ${date}]`;
  return out;
}

/** Machine ref embedded in a habit question so a text reply days later routes back to the
 *  right day + habit — the day lives in the message, never the DB. Matches `hb:DATE:INDEX`. */
export function parseHabitRef(text: string): { date: string; index: number } | null {
  const m = text.match(/hb:(\d{4}-\d{2}-\d{2}):(\d+)/);
  if (!m) return null;
  return { date: m[1]!, index: Number(m[2]) };
}
