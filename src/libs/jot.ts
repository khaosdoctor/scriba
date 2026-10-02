import { randomBytes } from "node:crypto";
import type {
  Jot,
  JotKind,
  JotSection,
  JotStatus,
} from "../domain/jot/entity.ts";
import { isEmbeddableUrl } from "./links.ts";
import { stripTilPrefix } from "./note.ts";
import { escapeHtml } from "./text.ts";
import { plainDate } from "./time.ts";

export function makeJotId(): string {
  return randomBytes(4).toString("hex");
}

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

export function embedOffer(text: string): "embed" | "plain" | undefined {
  let embedded = false;
  for (const m of text.matchAll(URL_FORMS)) {
    if (!isEmbeddableUrl(m[3] ?? m[4] ?? "")) continue;
    if (m[1] !== "!") return "embed";
    embedded = true;
  }
  return embedded ? "plain" : undefined;
}

export function setEmbeds(text: string, embed: boolean): string {
  return text.replace(URL_FORMS, (all, bang, label, linked, bare) => {
    const url = linked ?? bare;
    if (!isEmbeddableUrl(url)) return all;
    if (embed) return `![${label ?? ""}](${url})`;
    if (bang !== "!") return all;
    return label ? `[${label}](${url})` : url;
  });
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
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");
}

export function donePreview(kind: JotKind, textPart: string): string {
  const text = textPart.trim();
  if (text) return text;
  if (kind === "image" || kind === "video") return `${kind} saved to the note`;
  return "saved";
}

export function editedJotText(section: JotSection, text: string): string {
  if (section !== "til") return text;
  return stripTilPrefix(text) ?? text;
}

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

export type StatusButtons = {
  retry?: boolean;
  undo?: boolean;
  discard?: boolean;
  embed?: "embed" | "plain";
};

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

export function squashLine(total: number): string {
  return total > 1 ? `\n🧵 ${total} jots squashed into one entry` : "";
}

export function doneMessage(
  time: string,
  kind: JotKind,
  textPart: string,
  id: string,
  squashedTotal = 0,
  part?: { i: number; of: number },
): string {
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

export function heldNotice(kind: JotKind): string {
  return `⏸ Every enrichment model is down right now, so this ${kind} jot is waiting. It goes into your journal on its own once one is back.`;
}

export function gaveUpMessage(
  kind: JotKind,
  reason: string,
  error: string,
  squashedTotal = 0,
): string {
  return `⚠️ Gave up on a ${kind} jot (${reason}). Posted it un-enriched.\n${errorBlock(error)}${squashLine(squashedTotal)}`;
}

export function editConfirmation(time: string, text: string): string {
  return `✏️ Updated\n<blockquote>🕒 ${time} · ${escapeHtml(text.trim() || "…")}</blockquote>`;
}

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

export const STATUS_ICON: Record<JotStatus, string> = {
  pending: "⏳",
  processing: "⚙️",
  done: "✅",
  failed: "❌",
  abandoned: "🪦",
  deleted: "🗑",
};

export function jotPreview(j: Jot, maxLen = 40): string {
  return (j.transcript ?? j.raw_text ?? `(${j.kind})`)
    .replace(/\s+/g, " ")
    .slice(0, maxLen);
}
