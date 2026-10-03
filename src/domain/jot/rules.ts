import { basename } from "node:path";
import { escapeRe } from "../../libs/text.ts";
import {
  JOT_STATUSES,
  type Jot,
  type JotKind,
  type JotSection,
  type JotStatus,
  REPROCESSABLE_STATUSES,
} from "./entity.ts";
import type { StatusCounts } from "./structures.ts";

export function emptyStatusCounts(): StatusCounts {
  return Object.fromEntries(
    JOT_STATUSES.map((status) => [status, 0]),
  ) as StatusCounts;
}

/** A jot's line can be edited/deleted only once it exists in the note: done, or abandoned
 *  (posted un-enriched). Anything earlier still needs processing, so edits are queued. */
export function isEditableJot(status: JotStatus): boolean {
  return status === "done" || status === "abandoned";
}

export function isReprocessable(status: JotStatus): boolean {
  return (REPROCESSABLE_STATUSES as readonly JotStatus[]).includes(status);
}

export function isFollower(jot: Pick<Jot, "id" | "anchor">): boolean {
  return jot.anchor !== jot.id;
}

/** The daily note's date, which is the note file's name. */
export function jotDay(jot: Pick<Jot, "note_path">): string {
  return basename(jot.note_path, ".md");
}

export function sourceField(kind: JotKind): "transcript" | "raw_text" {
  return kind === "audio" ? "transcript" : "raw_text";
}

export function enrichableSource(jot: Jot, audioFallback = ""): string {
  if (jot.kind === "audio") return jot.transcript ?? audioFallback;
  if (jot.kind === "text" || jot.kind === "image") return jot.raw_text ?? "";
  return "";
}

/** Obsidian embed for a jot's saved asset, or "" when it has none. An image's caption is
 *  the entry text (see enrichableSource), so its embed carries no alias: Telegram's Bot API
 *  exposes no alt-text field to copy one from, and repeating the entry text inside the embed
 *  would only duplicate the line. Video stays attach-only, so its caption is the display. */
export function assetEmbed(jot: Jot): string {
  if (!jot.asset_path) return "";
  const alias = jot.kind === "video" && jot.raw_text;
  return alias
    ? `![[${jot.asset_path}|${jot.raw_text}]]`
    : `![[${jot.asset_path}]]`;
}

export function entryContent(jot: Jot, text: string): string {
  return [text, assetEmbed(jot)].filter(Boolean).join(" ");
}

export function withinSquashWindow(
  prevReceivedAt: number,
  nowReceivedAt: number,
  windowMs: number,
): boolean {
  return windowMs > 0 && nowReceivedAt - prevReceivedAt <= windowMs;
}

export function combineEnrichSource(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

export function editedJotText(section: JotSection, text: string): string {
  if (section !== "til") return text;
  return stripTilPrefix(text) ?? text;
}

/** From a set of jots (e.g. a /reprocess date/range query), the distinct ids to actually
 *  reprocess: a squashed follower's line lives on its leader's anchor, so a follower
 *  resolves to that leader's id rather than being reprocessed standalone. Order of first
 *  appearance is preserved. */
export function reprocessTargets(jots: Pick<Jot, "anchor">[]): string[] {
  return [...new Set(jots.map((jot) => jot.anchor))];
}

// "TIL", then a colon/dash or whitespace, then the actual text. "TIL" alone, or a word that
// merely starts with it ("tilde"), is an ordinary jot.
const TIL_PREFIX = /^til(?:\s*[:\-–—]+\s*|\s+)(?=[\s\S]*[\p{L}\p{N}])/iu;

export function stripTilPrefix(text: string): string | null {
  return TIL_PREFIX.test(text) ? text.replace(TIL_PREFIX, "") : null;
}

export function journalLine(
  time: string,
  text: string,
  anchor: string,
): string {
  return `- _${time} ::_ ${text} ^${anchor}`;
}

export function placeholderLine(time: string, anchor: string): string {
  return journalLine(time, "⏳", anchor);
}

// An Obsidian block anchor is `^` plus letters/digits/dashes at the end of the line, and
// journalLine always writes it after a space, so requiring that space keeps a trailing
// "3^2" in the text itself from being read as one.
const ANCHOR_SUFFIX = /\s+\^[A-Za-z0-9-]+[ \t\r]*$/;

export function stripJournalLine(line: string, time: string): string {
  return line
    .replace(new RegExp(`^- _${escapeRe(time)} ::_ `), "")
    .replace(ANCHOR_SUFFIX, "");
}
