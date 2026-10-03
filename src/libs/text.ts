import { createHash, randomBytes } from "node:crypto";

export function shortId(): string {
  return randomBytes(4).toString("hex");
}

// ponytail: swap for RegExp.escape once TypeScript ships its typedef (5.9 lacks it).
export const escapeRe = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function fingerprint(line: string): string {
  return createHash("sha1").update(line).digest("hex").slice(0, 8);
}

/** Reduce a fetched page to readable text. A string transform, never a browser: script and
 *  style bodies are dropped rather than run, and nothing here can execute JS. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_all, digits: string) =>
      String.fromCodePoint(Number(digits)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, at, all) => line !== "" || all[at - 1] !== "") // collapse blank runs
    .join("\n")
    .trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A sentence ends at a terminator (plus any closing quote/bracket) followed by whitespace
// and something that isn't a lowercase letter, so "e.g. this" and "v1. 2" stay whole while
// real sentence ends split. Zero-width, so `split` keeps every character.
const SENTENCE_BOUNDARY = /(?<=[.!?…]["')\]]*)\s+(?=[^\p{Ll}\s])/u;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

export function splitEntry(text: string, maxChars: number): string[] {
  const clean = collapse(text);
  if (!clean) return [];
  if (maxChars <= 0 || clean.length <= maxChars) return [clean];
  const out: string[] = [];
  for (const topic of text.split(/\n[ \t]*\n+/)) {
    let buf = "";
    for (const raw of topic.split(SENTENCE_BOUNDARY)) {
      const sentence = collapse(raw);
      if (!sentence) continue;
      const merged = buf ? `${buf} ${sentence}` : sentence;
      if (buf && merged.length > maxChars) {
        out.push(buf);
        buf = sentence;
      } else buf = merged;
    }
    if (buf) out.push(buf);
  }
  return out.length ? out : [clean];
}

// A message over 4096 characters is rejected outright, not trimmed, so a list built from an
// unbounded query has to stop somewhere and always say where: a list that quietly drops its
// tail reads as complete.
export const TELEGRAM_LIMIT = 4096;

export function fitTelegram(text: string, limit = TELEGRAM_LIMIT): string {
  if (text.length <= limit) return text;
  const notice = `\n… cut here — the rest is past Telegram's ${limit}-character limit.`;
  return `${text.slice(0, limit - notice.length)}${notice}`;
}

export function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function previewList(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} … +${items.length - max} more`;
}
