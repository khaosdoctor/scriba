import * as chrono from "chrono-node";
import { dateFromIso, plainDate } from "./time.ts";

/** URLs Obsidian renders inline when written as `![](url)`: YouTube videos, tweets and
 *  external images. Any other page needs an `<iframe>`, so it stays a plain link.
 *  ponytail: hand-kept list from Obsidian's "Embed web pages" help page, extended when
 *  Obsidian learns a new host. */
const EMBEDDABLE = [
  /^https?:\/\/(www\.|m\.)?(youtube\.com\/watch\?|youtu\.be\/)/i,
  /^https?:\/\/(www\.|mobile\.)?(twitter|x)\.com\/\w+\/status\/\d+/i,
  /^https?:\/\/[^?#]+\.(png|jpe?g|gif|webp|avif|svg|bmp)([?#]|$)/i,
];

export function isEmbeddableUrl(url: string): boolean {
  return EMBEDDABLE.some((re) => re.test(url));
}

export interface AliasEntry {
  note: string;
  alias: string;
}
export interface Candidate {
  surface: string;
  note: string;
  forced?: boolean;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function matchAlias(
  alias: string,
  lower: string,
  tokens: Set<string>,
): boolean {
  return alias.includes(" ") ? lower.includes(alias) : tokens.has(alias);
}

export function candidates(
  text: string,
  index: AliasEntry[],
  stopwords: Set<string>,
  rejected: Set<string>,
): Candidate[] {
  const tokens = new Set(tokenize(text));
  const lower = text.toLowerCase();
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const { note, alias } of index) {
    const a = alias.trim();
    const al = a.toLowerCase();
    if (a.length < 3 || stopwords.has(al)) continue; // 1-2 char aliases are junk; stopwords catch the rest
    if (!matchAlias(al, lower, tokens)) continue;
    const key = `${al} ${note}`;
    if (rejected.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ surface: a, note });
  }
  return out;
}

const wikilinkRe = /\[\[.*?\]\]/g;

/**
 * A chrono hit that pins down an actual day. chrono also matches bare times ("at 3pm",
 * "meeting at 9") by defaulting the day to the reference date (a clock time, not a
 * date), so the parse must have fixed a day/weekday/month. "now" resolves to today but
 * reads as "this moment", so its casual-reference tag rules it out. "for a week" / "for
 * 3 days" is a duration that chrono resolves to a day that far ahead ("been in the
 * dryer for a week now" became next Monday), so it's out too.
 */
export function isDateLike(r: chrono.ParsedResult): boolean {
  return (
    (r.start.isCertain("day") ||
      r.start.isCertain("weekday") ||
      r.start.isCertain("month")) &&
    !r.start.tags().has("casualReference/now") &&
    !/^for\s/i.test(r.text)
  );
}

export function linkDateWords(text: string, referenceDate: string): string {
  if (!text.trim()) return text;
  const linkSpans = [...text.matchAll(wikilinkRe)].map(
    (m) => [m.index, m.index + m[0].length] as const,
  );
  const overlapsLink = (start: number, end: number) =>
    linkSpans.some(([s, e]) => start < e && end > s);

  const ref = dateFromIso(referenceDate);
  // chrono leans on `\b`, which is ASCII-only in JS: in "Pokémon" the accented é counts as
  // a non-word char, so "mon" looks like a standalone weekday and the word gets a Monday
  // link spliced into the middle of it. Re-check both edges against a Unicode letter/digit
  // class so a match only survives when it really is a whole word.
  const wordChar = /[\p{L}\p{N}]/u;
  const insideWord = (start: number, end: number) =>
    wordChar.test(text[start - 1] ?? "") || wordChar.test(text[end] ?? "");
  const matches = chrono.en.casual
    .parse(text, ref)
    .filter(
      (r) =>
        isDateLike(r) &&
        !overlapsLink(r.index, r.index + r.text.length) &&
        !insideWord(r.index, r.index + r.text.length),
    )
    .sort((a, b) => b.index - a.index); // right-to-left so earlier indices stay valid

  let out = text;
  for (const r of matches) {
    const date = plainDate(r.start.date().getTime());
    const start = r.index;
    const end = start + r.text.length;
    out = `${out.slice(0, start)}[[${date}|${r.text}]]${out.slice(end)}`;
  }
  return out;
}

export function forcedCandidates(
  text: string,
  registered: { surface: string; note: string }[],
): Candidate[] {
  const tokens = new Set(tokenize(text));
  const lower = text.toLowerCase();
  const out: Candidate[] = [];
  for (const { surface, note } of registered) {
    const trimmed = surface.trim();
    const al = trimmed.toLowerCase();
    if (!al) continue;
    if (!matchAlias(al, lower, tokens)) continue;
    out.push({ surface: trimmed, note, forced: true });
  }
  return out;
}

export function parseRuleWords(text: string, limit = 20): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const word = part.trim().replace(/\s+/g, " ").toLowerCase();
    if (word && word.length <= 60) out.add(word);
    if (out.size >= limit) break;
  }
  return [...out];
}

export function cleanNoteTitle(text: string): string {
  return text
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function noteSuggestions(
  query: string,
  index: AliasEntry[],
  limit = 200,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const best = new Map<string, number>();
  for (const { note, alias } of index) {
    const a = alias.toLowerCase();
    const rank = a === q ? 0 : a.startsWith(q) ? 1 : a.includes(q) ? 2 : -1;
    if (rank < 0) continue;
    // alias length is the tiebreak, scaled so it can never outweigh the rank above
    const score = rank * 1000 + Math.min(alias.length, 999);
    const seen = best.get(note);
    if (seen === undefined || score < seen) best.set(note, score);
  }
  return [...best.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([note]) => note);
}

export function distinctSurfaces<T extends { surface: string }>(
  list: T[],
): string[] {
  return [...new Set(list.map((r) => r.surface))];
}
