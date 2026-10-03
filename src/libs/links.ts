import { basename } from "node:path";
import * as chrono from "chrono-node";
import {
  type AliasEntry,
  type Candidate,
  type LinkRule,
  linkRuleKey,
} from "../domain/link-rule/entity.ts";
import { frontmatterBlock } from "./note.ts";
import { collapse } from "./text.ts";
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

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function matchAlias(
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
    const trimmed = alias.trim();
    const lowered = trimmed.toLowerCase();
    if (trimmed.length < 3 || stopwords.has(lowered)) continue; // 1-2 char aliases are junk; stopwords catch the rest
    if (!matchAlias(lowered, lower, tokens)) continue;
    const key = linkRuleKey(lowered, note);
    if (rejected.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ surface: trimmed, note });
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
export function isDateLike(result: chrono.ParsedResult): boolean {
  return (
    (result.start.isCertain("day") ||
      result.start.isCertain("weekday") ||
      result.start.isCertain("month")) &&
    !result.start.tags().has("casualReference/now") &&
    !/^for\s/i.test(result.text)
  );
}

export function linkDateWords(text: string, referenceDate: string): string {
  if (!text.trim()) return text;
  const linkSpans = [...text.matchAll(wikilinkRe)].map(
    (link) => [link.index, link.index + link[0].length] as const,
  );
  const overlapsLink = (start: number, end: number) =>
    linkSpans.some(
      ([spanStart, spanEnd]) => start < spanEnd && end > spanStart,
    );

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
      (result) =>
        isDateLike(result) &&
        !overlapsLink(result.index, result.index + result.text.length) &&
        !insideWord(result.index, result.index + result.text.length),
    )
    .sort((left, right) => right.index - left.index); // right-to-left so earlier indices stay valid

  let out = text;
  for (const result of matches) {
    const date = plainDate(result.start.date().getTime());
    const start = result.index;
    const end = start + result.text.length;
    out = `${out.slice(0, start)}[[${date}|${result.text}]]${out.slice(end)}`;
  }
  return out;
}

export function forcedCandidates(
  text: string,
  registered: LinkRule[],
): Candidate[] {
  const tokens = new Set(tokenize(text));
  const lower = text.toLowerCase();
  const out: Candidate[] = [];
  for (const { surface, note } of registered) {
    const trimmed = surface.trim();
    const lowered = trimmed.toLowerCase();
    if (!lowered) continue;
    if (!matchAlias(lowered, lower, tokens)) continue;
    out.push({ surface: trimmed, note, forced: true });
  }
  return out;
}

export function parseRuleWords(text: string, limit = 20): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const word = collapse(part).toLowerCase();
    if (word && word.length <= 60) out.add(word);
    if (out.size >= limit) break;
  }
  return [...out];
}

export function cleanNoteTitle(text: string): string {
  return collapse(
    text
      .trim()
      .replace(/^\[\[|\]\]$/g, "")
      .replace(/^["']|["']$/g, ""),
  );
}

const unquote = (text: string) => text.trim().replace(/^["']|["']$/g, "");

export function parseAliasEntries(path: string, text: string): AliasEntry[] {
  const note = basename(path, ".md");
  const out: AliasEntry[] = [{ note, alias: note }]; // the title is always an alias
  const front = frontmatterBlock(text) ?? "";
  const inline = front.match(/^aliases:\s*\[(.*?)\]/m)?.[1];
  const block = front.match(/^aliases:\s*\n((?:\s*-\s*.+\n?)+)/m)?.[1];
  const items = inline?.trim()
    ? inline.split(",")
    : (block?.split("\n").map((line) => line.replace(/^\s*-\s*/, "")) ?? []);
  for (const alias of items.map(unquote).filter(Boolean))
    out.push({ note, alias });
  return out;
}

export function noteSuggestions(
  query: string,
  index: AliasEntry[],
  limit = 200,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const best = new Map<string, number>();
  for (const { note, alias } of index) {
    const lowered = alias.toLowerCase();
    const rank =
      lowered === needle
        ? 0
        : lowered.startsWith(needle)
          ? 1
          : lowered.includes(needle)
            ? 2
            : -1;
    if (rank < 0) continue;
    // alias length is the tiebreak, scaled so it can never outweigh the rank above
    const score = rank * 1000 + Math.min(alias.length, 999);
    const seen = best.get(note);
    if (seen === undefined || score < seen) best.set(note, score);
  }
  return [...best.entries()]
    .sort(
      (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, limit)
    .map(([note]) => note);
}

export function distinctSurfaces<T extends { surface: string }>(
  list: T[],
): string[] {
  return [...new Set(list.map((item) => item.surface))];
}
