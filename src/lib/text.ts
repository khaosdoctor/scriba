// Pure text helpers: deterministic, token-free, unit-tested in isolation.

// ponytail: swap for RegExp.escape once TypeScript ships its typedef (5.9 lacks it).
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reduce a fetched page to readable text. A string transform, never a browser: script and
 *  style bodies are dropped rather than run, and nothing here can execute JS. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    // Block-level ends become line breaks so the text keeps its shape.
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
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    );
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, all) => l !== "" || all[i - 1] !== "") // collapse blank runs
    .join("\n")
    .trim();
}

/** Escape the five characters that matter for Telegram's HTML parse mode.*/
export function escapeHtml(s: string): string {
  return s
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

/** A bullet is one line: newlines and runs of whitespace collapse to single spaces. */
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Split an entry's text into bullet-sized chunks of at most `maxChars`, splitting on topic
 * (blank-line) boundaries first and sentence boundaries within a topic. `maxChars` of 0
 * disables splitting; text already under the limit comes back as one chunk.
 */
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
/** Telegram's hard per-message character cap. */
export const TELEGRAM_LIMIT = 4096;

/** Last-resort guard on anything about to be sent: cut to the limit, visibly. Paginate at
 *  the source where you can; this only exists so an oversized message degrades to a
 *  labelled cut instead of a failed send. */
export function fitTelegram(text: string, limit = TELEGRAM_LIMIT): string {
  if (text.length <= limit) return text;
  const notice = `\n… cut here — the rest is past Telegram's ${limit}-character limit.`;
  return `${text.slice(0, limit - notice.length)}${notice}`;
}

/** `<n> <word>` with a naive plural "s" suffix for anything but 1. */
export function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Coarse human duration: "3d 4h", "5m 2s", "12s". */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** A typed entry-size reply: a whole number of characters, or "off" to stop splitting.
 *  Null when it isn't usable: under 40 characters no sentence would ever fit. */
export function parseEntrySize(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (s === "off" || s === "none" || s === "0") return 0;
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 40 && n <= 4000 ? n : null;
}

/** Inline preview of a list: the first `max` entries, then a count of what's left out. */
export function previewList(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} … +${items.length - max} more`;
}
