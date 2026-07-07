/**
 * Pure, dependency-free helpers. Deterministic, token-free — unit-tested in isolation.
 * Stopwords and rejections are injected (they live in the DB), not hardcoded here.
 */
import { randomBytes } from "node:crypto";

/** Fixed 8-char hex id, also used as the Obsidian block anchor. */
export function makeJotId(): string {
  return randomBytes(4).toString("hex");
}

/** Journal bullet in the vault's house style: `- _HH:MM:SS ::_ <text> ^anchor` */
export function journalLine(time: string, text: string, anchor: string): string {
  return `- _${time} ::_ ${text} ^${anchor}`;
}

/** Placeholder written the instant a jot arrives — fixes ordering, filled in later. */
export function placeholderLine(time: string, anchor: string): string {
  return journalLine(time, "⏳", anchor);
}

const anchorRe = (anchor: string) =>
  new RegExp(`^.*\\^${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");

/** Replace the whole line carrying `^anchor` with `newLine`. Returns null if not found. */
export function replaceAnchorLine(note: string, anchor: string, newLine: string): string | null {
  const re = anchorRe(anchor);
  if (!re.test(note)) return null;
  return note.replace(re, newLine);
}

/** Remove the line carrying `^anchor` entirely. Returns null if not found. */
export function deleteAnchorLine(note: string, anchor: string): string | null {
  const re = anchorRe(anchor);
  if (!re.test(note)) return null;
  return note.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

/** Extract the current text of the line carrying `^anchor` (for literal edits). */
export function anchorLine(note: string, anchor: string): string | null {
  return note.match(anchorRe(anchor))?.[0] ?? null;
}

export interface AliasEntry { note: string; alias: string; }
export interface Candidate { surface: string; note: string; }

/** Split text into lowercased word tokens, unicode-aware (keeps accented letters). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Propose link candidates from an alias index, cheaply and without any model call.
 * Drops junk (short/stopword aliases) and anything the user already rejected.
 * Whatever survives is handed to the agent, which makes the real call in context.
 * `stopwords` are lowercased words; `rejected` keys are `${lowercased-surface} ${note}`.
 */
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
    const hit = al.includes(" ") ? lower.includes(al) : tokens.has(al);
    if (!hit) continue;
    const key = `${al} ${note}`;
    if (rejected.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ surface: a, note });
  }
  return out;
}

/** Distinct surface terms worth a title lookup: >=3 chars, not a stopword. */
export function candidateTerms(text: string, stopwords: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokenize(text)) {
    if (t.length < 3 || stopwords.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Fallback candidate proposal when no local vault index is available: search each
 * surface term over REST (title matches only) instead of scanning an in-memory alias
 * list. `search` maps a term to matching note names. Single tokens only — multi-word
 * aliases need the filesystem index. Caps calls to keep one jot from fanning out.
 */
export async function candidatesViaSearch(
  text: string,
  search: (term: string) => Promise<string[]>,
  stopwords: Set<string>,
  rejected: Set<string>,
  maxTerms = 25,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const surface of candidateTerms(text, stopwords).slice(0, maxTerms)) {
    let notes: string[];
    try { notes = await search(surface); } catch { continue; }
    for (const note of notes) {
      const key = `${surface} ${note}`;
      if (rejected.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ surface, note });
    }
  }
  return out;
}

/**
 * Parse a literal edit instruction into an {old,new} swap, or null if freeform
 * (freeform goes to the agent). Supports `s/old/new/` and `replace X with Y`.
 */
export function parseLiteralEdit(msg: string): { old: string; new: string } | null {
  const s = msg.trim();
  const sed = s.match(/^s\/((?:\\.|[^/])+)\/((?:\\.|[^/])*)\/?$/);
  if (sed && sed[1] !== undefined && sed[2] !== undefined) {
    return { old: sed[1].replace(/\\\//g, "/"), new: sed[2].replace(/\\\//g, "/") };
  }
  const repl = s.match(/^replace\s+"?(.+?)"?\s+with\s+"?(.+?)"?$/i);
  if (repl && repl[1] !== undefined && repl[2] !== undefined) {
    return { old: repl[1], new: repl[2] };
  }
  return null;
}
