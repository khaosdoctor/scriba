// Pure jot helpers: deterministic, token-free, unit-tested in isolation.
import { randomBytes } from "node:crypto";
import type { Jot, JotKind, JotSection, JotStatus } from "../models/domain.ts";
import { isEmbeddableUrl } from "./links.ts";
import { stripTilPrefix } from "./note.ts";

/** Fixed 8-char hex id, also used as the Obsidian block anchor. */
export function makeJotId(): string {
  return randomBytes(4).toString("hex");
}

/** Errors worth retrying (transient infra); anything else is treated as unrecoverable. */
export function isRecoverable(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // "connection error" / "timed out" are the OpenAI-shaped SDKs' (Groq, OpenCode) words
  // for the same network failures.
  return /timeout|timed out|connection error|etimedout|econnrefused|econnreset|enotfound|eai_again|fetch failed|socket|network|429|overloaded|\b5\d\d\b/.test(
    m,
  );
}

/** A jot's line can be edited/deleted only once it exists in the note: done, or abandoned
 *  (posted un-enriched). Anything earlier still needs processing, so edits are queued. */
export function isEditableJot(status: JotStatus): boolean {
  return status === "done" || status === "abandoned";
}

/** Pick the enrichable source text for a jot's kind: the transcript for audio (falling back
 *  to `audioFallback` when there isn't one), the raw text for text, and an image's caption
 *  (what you typed alongside the photo is the entry, same as any other jot, so it gets
 *  enriched and wikilinked rather than being demoted to the embed's alt text). A
 *  captionless image uses its vision caption here. Video is still attach-only. */
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

// One matcher for every URL form in a line: `![alt](url)` (embedded), `[text](url)`
// (markdown link), or a bare URL. Trailing punctuation belongs to the sentence.
const URL_FORMS =
  /(!?)\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|(?<![\w/([<])(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/g;

/** Which embed toggle a line can offer: `"embed"` when it holds an embeddable URL written
 *  as a link, `"plain"` when every one is already embedded, undefined when it has none. */
export function embedOffer(text: string): "embed" | "plain" | undefined {
  let embedded = false;
  for (const m of text.matchAll(URL_FORMS)) {
    if (!isEmbeddableUrl(m[3] ?? m[4] ?? "")) continue;
    if (m[1] !== "!") return "embed";
    embedded = true;
  }
  return embedded ? "plain" : undefined;
}

/** Rewrite every embeddable URL in a line as an Obsidian embed (`embed: true`) or back to
 *  a link. `[text](url)` keeps its text as the embed's alt; a bare URL embeds as `![](url)`
 *  and comes back bare. Other URLs are left alone. */
export function setEmbeds(text: string, embed: boolean): string {
  return text.replace(URL_FORMS, (all, bang, label, linked, bare) => {
    const url = linked ?? bare;
    if (!isEmbeddableUrl(url)) return all;
    if (embed) return `![${label ?? ""}](${url})`;
    if (bang !== "!") return all;
    return label ? `[${label}](${url})` : url;
  });
}

/** Rolling-window test for squashing: a new jot folds into the previous still-open one
 *  when it arrived within `windowMs` of it. A `windowMs` of 0 disables squashing. */
export function withinSquashWindow(
  prevReceivedAt: number,
  nowReceivedAt: number,
  windowMs: number,
): boolean {
  return windowMs > 0 && nowReceivedAt - prevReceivedAt <= windowMs;
}

/** Join a squash group's source texts into one blob for a single enrichment pass.
 *  Blank parts are dropped so an empty caption or failed transcript adds no noise. */
export function combineEnrichSource(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");
}

/** Confirmation of what was written to the note, shown in full. Attach-only jots carry no text. */
export function donePreview(kind: JotKind, textPart: string): string {
  const text = textPart.trim();
  if (text) return text;
  if (kind === "image" || kind === "video") return `${kind} saved to the note`;
  return "saved";
}

/** Text of a natively edited message as it belongs on the jot's line: a TIL jot keeps its
 *  marker out of the note, so an edit that still starts with "TIL" loses it again. */
export function editedJotText(section: JotSection, text: string): string {
  if (section !== "til") return text;
  return stripTilPrefix(text) ?? text;
}

/**
 * Parse a literal edit instruction into an {old,new} swap, or null if freeform
 * (freeform goes to the agent). Supports `s/old/new/` and `replace X with Y`.
 */
export function parseLiteralEdit(
  msg: string,
): { old: string; new: string } | null {
  const s = msg.trim();
  const sed = s.match(/^s\/((?:\\.|[^/])+)\/((?:\\.|[^/])*)\/?$/);
  if (sed && sed[1] !== undefined && sed[2] !== undefined) {
    return {
      old: sed[1].replace(/\\\//g, "/"),
      new: sed[2].replace(/\\\//g, "/"),
    };
  }
  const repl = s.match(/^replace\s+"?(.+?)"?\s+with\s+"?(.+?)"?$/i);
  if (repl && repl[1] !== undefined && repl[2] !== undefined) {
    return { old: repl[1], new: repl[2] };
  }
  return null;
}

/** From a set of jots (e.g. a /reprocess date/range query), the distinct ids to actually
 *  reprocess: a squashed follower's line lives on its leader's anchor, so a follower
 *  resolves to that leader's id rather than being reprocessed standalone. Order of first
 *  appearance is preserved. */
export function reprocessTargets(jots: Pick<Jot, "anchor">[]): string[] {
  return [...new Set(jots.map((j) => j.anchor))];
}
