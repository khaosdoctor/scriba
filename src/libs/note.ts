import { escapeRe } from "./text.ts";

export const frontmatterBlock = (text: string): string | undefined =>
  text.match(/^---\n([\s\S]*?)\n---/)?.[1];

export function findSection(
  lines: string[],
  heading: string,
): { headingIdx: number; end: number } | null {
  const headingRe = new RegExp(`^#{1,6}\\s+${escapeRe(heading)}\\s*$`);
  const headingIdx = lines.findIndex((line) => headingRe.test(line));
  if (headingIdx === -1) return null;
  let end = lines.length;
  for (let index = headingIdx + 1; index < lines.length; index++) {
    if (/^#{1,6}\s/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return { headingIdx, end };
}

export function stampCompletion(line: string, date: string): string {
  if (/\[\s*completion\s*::/i.test(line)) return line;
  return `${line.replace(/\s*$/, "")} [completion:: ${date}]`;
}

export function sectionHasContent(note: string, heading: string): boolean {
  const lines = note.split("\n");
  const section = findSection(lines, heading);
  if (!section) return false;
  return lines
    .slice(section.headingIdx + 1, section.end)
    .some(
      (line) =>
        !/^\s*(?:[-*+](?:\s+\[[ xX]\])?\s*|-{3,}|<!--.*-->)?\s*$/.test(line),
    );
}

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
  for (let index = headingIdx + 1; index < end; index++) {
    if (/^\s*-\s*$/.test(lines[index]!)) emptyBullets.push(index);
    else if (/^\s*-\s/.test(lines[index]!)) lastBullet = index;
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
  for (const index of emptyBullets.slice(1).reverse()) lines.splice(index, 1);
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
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === "---") {
      close = index;
      break;
    }
  }
  if (close === -1) return `---\n${key}: ${value}\n---\n\n${note}`; // no closing fence: wrap
  const keyRe = new RegExp(`^${escapeRe(key)}\\s*:`);
  for (let index = 1; index < close; index++) {
    if (keyRe.test(lines[index]!)) {
      lines[index] = `${key}: ${value}`;
      return lines.join("\n");
    }
  }
  lines.splice(close, 0, `${key}: ${value}`); // key absent: add it before the closing fence
  return lines.join("\n");
}

const anchorRe = (anchor: string) =>
  new RegExp(`^.*\\^${escapeRe(anchor)}[ \\t\\r]*$`, "m");

export function replaceAnchorLine(
  note: string,
  anchor: string,
  newLine: string,
): string | null {
  const re = anchorRe(anchor);
  if (!re.test(note)) return null;
  return note.replace(re, () => newLine); // function replacer: `$&` in the text is literal
}

export function deleteAnchorLine(note: string, anchor: string): string | null {
  const re = anchorRe(anchor);
  if (!re.test(note)) return null;
  return note.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

export function anchorLine(note: string, anchor: string): string | null {
  return note.match(anchorRe(anchor))?.[0] ?? null;
}

type MoveResult = { note: string } | { missing: "line" | "heading" };

/** Cut the anchored line out and insert it under `heading`, passed through `rewrite` on
 *  the way (the TIL move drops the time stamp there). */
export function moveAnchorLine(
  note: string,
  anchor: string,
  heading: string,
  rewrite: (line: string) => string = (line) => line,
): MoveResult {
  const line = anchorLine(note, anchor);
  if (line === null) return { missing: "line" };
  if (!findSection(note.split("\n"), heading)) return { missing: "heading" };
  const without = note.replace(
    new RegExp(`${anchorRe(anchor).source}\\n?`, "m"),
    "",
  );
  return { note: insertJournalLine(without, heading, rewrite(line)) };
}
