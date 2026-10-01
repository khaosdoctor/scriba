// Pure jot helpers: deterministic, token-free, unit-tested in isolation.
import { randomBytes } from "node:crypto";
import type { Jot, JotKind, JotSection, JotStatus } from "../models/domain.ts";
import type { StatusButtons } from "../models/ops.ts";
import { isEmbeddableUrl } from "./links.ts";
import { stripTilPrefix } from "./note.ts";
import { escapeHtml } from "./text.ts";
import { plainDate } from "./time.ts";

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

// --- status message texts and buttons ---

/** The buttons under a jot's status message, as Telegram's inline keyboard markup. Empty
 *  (which clears any existing keyboard) when none is asked for, so a message that's no
 *  longer actionable stops offering actions. */
export function statusKeyboard(jotId: string, opts?: StatusButtons) {
  const row: { text: string; callback_data: string }[] = [];
  if (opts?.undo) row.push({ text: "↩️ Undo", callback_data: `un:${jotId}` });
  if (opts?.embed === "embed")
    row.push({ text: "🖼 Embed", callback_data: `em:${jotId}:1` });
  if (opts?.embed === "plain")
    row.push({ text: "🔗 Plain link", callback_data: `em:${jotId}:0` });
  if (opts?.retry) row.push({ text: "🔄 Retry", callback_data: `rt:${jotId}` });
  if (opts?.discard)
    row.push({ text: "🗑 Delete", callback_data: `dl:${jotId}` });
  return { inline_keyboard: [row] };
}

/** `total` is the number of jots folded into one line (leader + followers); 0 means no
 *  squash. The single confirmation notes it so the merge is explained. */
export function squashLine(total: number): string {
  return total > 1 ? `\n🧵 ${total} jots squashed into one entry` : "";
}

/** Final in-chat confirmation once a jot is written: the saved line blockquoted with its
 *  time so it is easy to spot. HTML parse mode: content is escaped. */
export function doneMessage(
  time: string,
  kind: JotKind,
  textPart: string,
  id: string,
  squashedTotal = 0,
  part?: { i: number; of: number },
): string {
  // `part` is set when the text was too long and got split: each piece is its own jot with
  // its own message, so say which one this is.
  const split = part ? `\n✂️ part ${part.i} of ${part.of}` : "";
  return `✅ Saved to your journal\n<blockquote>🕒 ${time} · ${escapeHtml(donePreview(kind, textPart))}</blockquote>\n🔖 <code>${id}</code>${squashLine(squashedTotal)}${split}`;
}

// A failure message is only as useful as what you can do about it, and both messages below
// are posted with 🔄 Retry / 🗑 Delete under them. An error string can be a whole stack
// trace, which would push the message past Telegram's limit, so it's cut here.
const ERROR_PREVIEW_CHARS = 400;

const errorBlock = (error: string) => {
  const text = error.trim() || "(no error message)";
  const cut = text.length > ERROR_PREVIEW_CHARS;
  return `<code>${escapeHtml(cut ? `${text.slice(0, ERROR_PREVIEW_CHARS)}…` : text)}</code>`;
};

/** Status line for a jot that failed on a transient error and is still in the retry cycle.
 *  Without this the message stays on "Weaving it into your journal…" until the retry pass
 *  comes round, which reads as a jot that's stuck rather than one that's waiting. */
export function retryNotice(
  kind: JotKind,
  attempts: number,
  max: number,
  error: string,
): string {
  const left = Math.max(0, max - attempts);
  const more = left === 1 ? "one more try" : `${left} more tries`;
  return `⚠️ That ${kind} jot didn't go through (attempt ${attempts} of ${max}). I'll try again on my own — ${more} left, or decide it now.\n${errorBlock(error)}`;
}

/** Status line for a jot held back because every enrichment model is down. It keeps its
 *  place in the note and isn't charged a retry; the retry pass picks it up once one is back. */
export function heldNotice(kind: JotKind): string {
  return `⏸ Every enrichment model is down right now, so this ${kind} jot is waiting. It goes into your journal on its own once one is back.`;
}

/** Status line once a jot is given up on. The text is in the note un-enriched, so what's
 *  left to decide is whether to run it again or take it out. */
export function gaveUpMessage(
  kind: JotKind,
  reason: string,
  error: string,
  squashedTotal = 0,
): string {
  return `⚠️ Gave up on a ${kind} jot (${reason}). Posted it un-enriched.\n${errorBlock(error)}${squashLine(squashedTotal)}`;
}

/** In-chat confirmation after an edit is applied: the corrected line blockquoted so the
 *  new text is visible immediately rather than a bare "updated". HTML parse mode: content
 *  is escaped. */
export function editConfirmation(time: string, text: string): string {
  return `✏️ Updated\n<blockquote>🕒 ${time} · ${escapeHtml(text.trim() || "…")}</blockquote>`;
}

/** /jot body: full record for one jot. */
export function formatJotDetail(j: Jot): string {
  const text = j.transcript ?? j.raw_text ?? "(none)";
  const lines = [
    `🧾 ${j.id} [${j.kind}] — ${j.status}`,
    `Received: ${plainDate(j.received_at)} ${j.time}`,
    `Attempts: ${j.attempts}`,
    `Note: ${j.note_path} ^${j.anchor}`,
  ];
  if (j.asset_path) lines.push(`Asset: ${j.asset_path}`);
  if (j.error) lines.push(`Error: ${j.error}`);
  lines.push(`Text: ${text}`);
  return lines.join("\n");
}

/** One glyph per jot status: the /menu jots browser and /reprocess pickers. */
export const STATUS_ICON: Record<JotStatus, string> = {
  pending: "⏳",
  processing: "⚙️",
  done: "✅",
  failed: "❌",
  abandoned: "🪦",
  deleted: "🗑",
};

/** One-line content preview for list pickers (the /menu jots browser, /reprocess).
 *  Falls back to "(kind)" for attach-only jots with no caption. */
export function jotPreview(j: Jot, maxLen = 40): string {
  return (j.transcript ?? j.raw_text ?? `(${j.kind})`)
    .replace(/\s+/g, " ")
    .slice(0, maxLen);
}
