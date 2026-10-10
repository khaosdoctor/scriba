import { errorText } from "./text.ts";

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  lastError: unknown;

  constructor(
    private threshold: number,
    private cooldownMs: number,
    private now: () => number = Date.now,
  ) {}

  allows(): boolean {
    return this.now() >= this.openUntil;
  }

  success(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.lastError = undefined;
  }

  failure(err: unknown): void {
    this.failures++;
    this.lastError = err;
    if (this.failures >= this.threshold)
      this.openUntil = this.now() + this.cooldownMs;
  }
}

export type SwitchTarget = "fallback" | "primary" | "down";

export function switchNotice(
  to: SwitchTarget,
  model: string,
  err?: unknown,
): string {
  const reason = errorText(err);
  switch (to) {
    case "fallback":
      return `⚠️ Enrichment switched to fallback model ${model}. Quality may drop until the chosen model is back.\nReason: ${reason}`;
    case "primary":
      return `✅ Enrichment is back on ${model}.`;
    case "down":
      return `⏸ Every enrichment model is down, so new jots are held in place. They go into your journal on their own once one is back.\nReason: ${reason}`;
    default:
      return to satisfies never;
  }
}

export function isRecoverable(err: unknown): boolean {
  const message = errorText(err).toLowerCase();
  // "connection error" / "timed out" are the OpenAI-shaped SDKs' (Groq, OpenCode) words
  // for the same network failures.
  return /timeout|timed out|connection error|etimedout|econnrefused|econnreset|enotfound|eai_again|fetch failed|socket|network|429|overloaded|\b5\d\d\b/.test(
    message,
  );
}

/** Escape raw control characters (a literal newline, tab…) that appear inside JSON string
 *  literals. Weaker chat models write a multi-paragraph "text" with real line breaks,
 *  which JSON.parse rejects outright; outside a string they're whitespace and stay. */
function escapeControlsInStrings(source: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += JSON.stringify(ch).slice(1, -1); // \n, \t, \u0001…
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

export function parseModelJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const open = cleaned.indexOf("{"),
    close = cleaned.lastIndexOf("}");
  const spans = [cleaned];
  if (open >= 0 && close > open) spans.push(cleaned.slice(open, close + 1));
  for (const span of spans)
    for (const attempt of [span, escapeControlsInStrings(span)]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          return parsed;
      } catch {
        /* next attempt */
      }
    }
  return null;
}

interface ModelPayload {
  text: string;
  ambiguous?: unknown;
  tasks?: unknown;
  til?: unknown;
}

export function unwrapModelPayload(payload: ModelPayload): ModelPayload {
  let out = { ...payload };
  for (let depth = 0; depth < 3; depth++) {
    const trimmed = out.text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("```")) break;
    const inner = parseModelJson(trimmed);
    if (!inner || typeof inner.text !== "string") break;
    const empty = (value: unknown) =>
      !Array.isArray(value) || value.length === 0;
    out = {
      text: inner.text,
      ambiguous: empty(out.ambiguous)
        ? (inner.ambiguous ?? out.ambiguous)
        : out.ambiguous,
      tasks: empty(out.tasks) ? (inner.tasks ?? out.tasks) : out.tasks,
      til: out.til === true ? true : (inner.til ?? out.til),
    };
  }
  out.text = stripWrappingQuotes(out.text);
  return out;
}

/** Opening quote → the closing quote that pairs with it. Straight single quotes are left
 *  out: an entry can open on "'Twas" and end on "the students'". */
const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "\u201C": "\u201D", // “ ”
  "\u201E": "\u201C", // „ “
  "\u2018": "\u2019", // ‘ ’
  "\u00AB": "\u00BB", // « »
};

/** A jot is never one quotation from end to end, so a model answer wrapped in quotes
 *  (echoing the prompt's `"""` fence, or a plain `"…"`) is unwrapped, layer by layer.
 *  A pair only counts when the closing quote appears nowhere inside, so `"A" and "B"`
 *  keeps its quotes. */
export function stripWrappingQuotes(text: string): string {
  let out = text.trim();
  for (let depth = 0; depth < 5; depth++) {
    const fenced = out.match(/^"""([\s\S]*)"""$/);
    if (fenced) {
      out = (fenced[1] ?? "").trim();
      continue;
    }
    const close = QUOTE_PAIRS[out[0] ?? ""];
    if (close === undefined || out.length < 2 || !out.endsWith(close)) break;
    const inner = out.slice(1, -1);
    if (inner.includes(close)) break;
    out = inner.trim();
  }
  return out;
}
