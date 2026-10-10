import type { Jot, JotKind, JotStatus } from "../domain/jot/entity.ts";
import { isEmbeddableUrl } from "./links.ts";
import { clipUpdate, escapeHtml } from "./text.ts";
import { plainDate } from "./time.ts";

// One matcher for every URL form in a line: `![alt](url)` (embedded), `[text](url)`
// (markdown link), or a bare URL. Trailing punctuation belongs to the sentence.
const URL_FORMS =
  /(!?)\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|(?<![\w/([<])(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/g;

export function embedOffer(text: string): "embed" | "plain" | undefined {
  let embedded = false;
  for (const match of text.matchAll(URL_FORMS)) {
    if (!isEmbeddableUrl(match[3] ?? match[4] ?? "")) continue;
    if (match[1] !== "!") return "embed";
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

export function donePreview(kind: JotKind, textPart: string): string {
  const text = textPart.trim();
  if (text) return text;
  if (kind === "image" || kind === "video") return `${kind} saved to the note`;
  return "saved";
}

export function parseLiteralEdit(
  msg: string,
): { old: string; new: string } | null {
  const trimmed = msg.trim();
  const sed = trimmed.match(/^s\/((?:\\.|[^/])+)\/((?:\\.|[^/])*)\/?$/);
  if (sed && sed[1] !== undefined && sed[2] !== undefined) {
    return {
      old: sed[1].replace(/\\\//g, "/"),
      new: sed[2].replace(/\\\//g, "/"),
    };
  }
  const repl = trimmed.match(/^replace\s+"?(.+?)"?\s+with\s+"?(.+?)"?$/i);
  if (repl && repl[1] !== undefined && repl[2] !== undefined) {
    return { old: repl[1], new: repl[2] };
  }
  return null;
}

export type StatusButtons = {
  retry?: boolean;
  undo?: boolean;
  discard?: boolean;
  embed?: "embed" | "plain";
  /** The voice fix rewrote the transcript: offer the raw one back. */
  original?: boolean;
};

export const UNDO_NS = "un";
export const EMBED_NS = "em";
export const RETRY_NS = "rt";
export const DELETE_NS = "dl";
export const ORIGINAL_NS = "vf";
export const EDIT_NS = "ed";

/** The marker an ✏️ Edit prompt carries, so the reply to it is routed back to its jot
 *  with nothing held in memory. */
export function editRef(jotId: string): string {
  return `(${EDIT_NS}:${jotId})`;
}

export function parseEditRef(text: string): string | null {
  return text.match(/\(ed:([0-9a-f]{8})\)/)?.[1] ?? null;
}

export function statusKeyboard(jotId: string, opts?: StatusButtons) {
  const row: { text: string; callback_data: string }[] = [];
  if (opts?.undo) {
    row.push({ text: "✏️ Edit", callback_data: `${EDIT_NS}:${jotId}` });
    row.push({ text: "↩️ Undo", callback_data: `${UNDO_NS}:${jotId}` });
  }
  if (opts?.embed === "embed")
    row.push({ text: "🖼 Embed", callback_data: `${EMBED_NS}:${jotId}:1` });
  if (opts?.embed === "plain")
    row.push({
      text: "🔗 Plain link",
      callback_data: `${EMBED_NS}:${jotId}:0`,
    });
  if (opts?.original)
    row.push({
      text: "📝 Use original",
      callback_data: `${ORIGINAL_NS}:${jotId}`,
    });
  if (opts?.retry)
    row.push({ text: "🔄 Retry", callback_data: `${RETRY_NS}:${jotId}` });
  if (opts?.discard)
    row.push({ text: "🗑 Delete", callback_data: `${DELETE_NS}:${jotId}` });
  return { inline_keyboard: [row] };
}

function squashLine(total: number): string {
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

/** Cap on the raw transcript shown under a fixed voice jot, so the status stays inside
 *  Telegram's 4096 characters next to the entry itself. */
const ORIGINAL_CHARS = 1500;

/** The transcript as it came from the transcriber, folded away under the finished status of
 *  a voice jot the fix rewrote, so 📝 Use original is never a blind tap. */
export function originalQuote(original: string): string {
  return `\n🎤 Original transcript:\n<blockquote expandable>${escapeHtml(clipUpdate(original, ORIGINAL_CHARS))}</blockquote>`;
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

export function formatJotDetail(jot: Jot): string {
  const text = jot.transcript ?? jot.raw_text ?? "(none)";
  const lines = [
    `🧾 ${jot.id} [${jot.kind}] — ${jot.status}`,
    `Received: ${plainDate(jot.received_at)} ${jot.time}`,
    `Attempts: ${jot.attempts}`,
    `Note: ${jot.note_path} ^${jot.anchor}`,
  ];
  if (jot.asset_path) lines.push(`Asset: ${jot.asset_path}`);
  if (jot.error) lines.push(`Error: ${jot.error}`);
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

export function jotPreview(jot: Jot, maxLen = 40): string {
  return (jot.transcript ?? jot.raw_text ?? `(${jot.kind})`)
    .replace(/\s+/g, " ")
    .slice(0, maxLen);
}
