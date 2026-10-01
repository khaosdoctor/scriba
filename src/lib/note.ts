// Pure note helpers: deterministic, token-free, unit-tested in isolation.
import { escapeRe } from "./text.ts";

/** Journal bullet in the vault's house style: `- _HH:MM:SS ::_ <text> ^anchor` */
export function journalLine(
  time: string,
  text: string,
  anchor: string,
): string {
  return `- _${time} ::_ ${text} ^${anchor}`;
}

// "TIL", then a colon/dash or whitespace, then the actual text. "TIL" alone, or a word that
// merely starts with it ("tilde"), is an ordinary jot.
const TIL_PREFIX = /^til(?:\s*[:\-–—]+\s*|\s+)(?=[\s\S]*[\p{L}\p{N}])/iu;

/** The text after a leading "TIL" marker, or null when the jot doesn't start with one.
 *  The heading already says it is a TIL, so the marker itself is dropped. */
export function stripTilPrefix(text: string): string | null {
  return TIL_PREFIX.test(text) ? text.replace(TIL_PREFIX, "") : null;
}

/** Placeholder written the instant a jot arrives, fixes ordering, filled in later. */
export function placeholderLine(time: string, anchor: string): string {
  return journalLine(time, "⏳", anchor);
}

// An Obsidian block anchor is `^` plus letters/digits/dashes at the end of the line, and
// journalLine always writes it after a space, so requiring that space keeps a trailing
// "3^2" in the text itself from being read as one.
const ANCHOR_SUFFIX = /\s+\^[A-Za-z0-9-]+[ \t\r]*$/;

/** Strip the `- _time ::_ ` prefix and ` ^anchor` suffix off a journal line, leaving
 *  just its content (for literal edits). */
export function stripJournalLine(line: string, time: string): string {
  return line
    .replace(new RegExp(`^- _${escapeRe(time)} ::_ `), "")
    .replace(ANCHOR_SUFFIX, "");
}

/** Line range of the section under `heading`: the heading's index and the index of the next
 *  heading (or the end of the note). Null when the note has no such heading. */
export function findSection(
  lines: string[],
  heading: string,
): { headingIdx: number; end: number } | null {
  const headingRe = new RegExp(`^#{1,6}\\s+${escapeRe(heading)}\\s*$`);
  const headingIdx = lines.findIndex((l) => headingRe.test(l));
  if (headingIdx === -1) return null;
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { headingIdx, end };
}

/** Append `[completion:: date]` to a task or habit line unless it already has one. */
export function stampCompletion(line: string, date: string): string {
  if (/\[\s*completion\s*::/i.test(line)) return line;
  return `${line.replace(/\s*$/, "")} [completion:: ${date}]`;
}

/** Does the section under `heading` hold anything beyond what the template puts there?
 *  Blank lines, empty bullets (`-`, `- `, `- [ ]`), horizontal rules and HTML comments are
 *  template scaffolding; any other line is content. A missing heading counts as empty. */
export function sectionHasContent(note: string, heading: string): boolean {
  const lines = note.split("\n");
  const section = findSection(lines, heading);
  if (!section) return false;
  return lines
    .slice(section.headingIdx + 1, section.end)
    .some(
      (l) => !/^\s*(?:[-*+](?:\s+\[[ xX]\])?\s*|-{3,}|<!--.*-->)?\s*$/.test(l),
    );
}

/** Insert a journal bullet under `heading`, keeping the vault's indentation:
 *  immediately after the last bullet in that section, or replacing the list when
 *  it holds only the empty template bullet. Falls back to a heading-less append. */
export function insertJournalLine(
  note: string,
  heading: string,
  line: string,
): string {
  const lines = note.split("\n");
  const section = findSection(lines, heading);
  if (!section) return `${note.replace(/\n*$/, "")}\n${line}\n`;
  const { headingIdx, end } = section;

  let lastBullet = -1;
  const emptyBullets: number[] = [];
  for (let i = headingIdx + 1; i < end; i++) {
    if (/^\s*-\s*$/.test(lines[i]!)) emptyBullets.push(i);
    else if (/^\s*-\s/.test(lines[i]!)) lastBullet = i;
  }

  if (lastBullet !== -1) {
    lines.splice(lastBullet + 1, 0, line);
    return lines.join("\n");
  }
  if (emptyBullets.length === 0) {
    lines.splice(headingIdx + 1, 0, line);
    return lines.join("\n");
  }
  lines[emptyBullets[0]!] = line;
  for (const i of emptyBullets.slice(1).reverse()) lines.splice(i, 1);
  return lines.join("\n");
}

/** Set a scalar YAML frontmatter field, replacing it in place or inserting it into
 *  (or creating) the `---` block at the top of the note. Always returns a note that
 *  carries `key: value`. The value is written raw, so it must be something YAML reads as a
 *  scalar (a number, a date, an unquoted word); this is not a general YAML writer. */
export function setFrontmatterValue(
  note: string,
  key: string,
  value: string | number,
): string {
  const lines = note.split("\n");
  if (lines[0] !== "---") return `---\n${key}: ${value}\n---\n\n${note}`;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return `---\n${key}: ${value}\n---\n\n${note}`; // no closing fence: wrap
  const keyRe = new RegExp(`^${escapeRe(key)}\\s*:`);
  for (let i = 1; i < close; i++) {
    if (keyRe.test(lines[i]!)) {
      lines[i] = `${key}: ${value}`;
      return lines.join("\n");
    }
  }
  lines.splice(close, 0, `${key}: ${value}`); // key absent: add it before the closing fence
  return lines.join("\n");
}

const anchorRe = (anchor: string) =>
  new RegExp(`^.*\\^${escapeRe(anchor)}[ \\t\\r]*$`, "m");

/** Replace the whole line carrying `^anchor` with `newLine`. Returns null if not found.
 *  `newLine` may itself be several lines: a jot that split into parts writes its own line
 *  plus its parts' lines in one go, so they arrive together and in order. */
export function replaceAnchorLine(
  note: string,
  anchor: string,
  newLine: string,
): string | null {
  const re = anchorRe(anchor);
  if (!re.test(note)) return null;
  return note.replace(re, () => newLine); // function replacer: `$&` in the text is literal
}

/** Remove the line carrying `^anchor`. Returns null if not found. */
export function deleteAnchorLine(note: string, anchor: string): string | null {
  const re = anchorRe(anchor);
  if (!re.test(note)) return null;
  return note.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

/** Extract the current text of the line carrying `^anchor` (for literal edits). */
export function anchorLine(note: string, anchor: string): string | null {
  return note.match(anchorRe(anchor))?.[0] ?? null;
}

export type MoveResult = { note: string } | { missing: "line" | "heading" };

/** Move the line carrying `^anchor` under `heading`, keeping the line (and so its anchor)
 *  exactly as it is. Says what is missing instead of moving when the anchor or the heading
 *  isn't in the note: without the heading the line would be appended at the end of it. */
export function moveAnchorLine(
  note: string,
  anchor: string,
  heading: string,
): MoveResult {
  const line = anchorLine(note, anchor);
  if (line === null) return { missing: "line" };
  if (!findSection(note.split("\n"), heading)) return { missing: "heading" };
  const without = note.replace(
    new RegExp(`${anchorRe(anchor).source}\\n?`, "m"),
    "",
  );
  return { note: insertJournalLine(without, heading, line) };
}
