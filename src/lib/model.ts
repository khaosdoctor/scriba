// Pure model-payload helpers: deterministic, token-free, unit-tested in isolation.

/**
 * Per-upstream circuit breaker, token-free. `threshold` failures in a row open it for
 * `cooldownMs`, during which `allows()` is false and callers skip straight to the next
 * option. Once the cooldown is up one trial call is let through: success closes it, a
 * failure opens it for another cooldown.
 */
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

/** Escape raw control characters (a literal newline, tab…) that appear inside JSON string
 *  literals. Weaker chat models write a multi-paragraph "text" with real line breaks,
 *  which JSON.parse rejects outright; outside a string they're whitespace and stay. */
function escapeControlsInStrings(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of s) {
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

/** Read a model's free-text answer as a JSON object. Usually it is clean JSON; sometimes
 *  it's wrapped in a ```json fence or a stray sentence, or carries raw line breaks inside
 *  a string. Tries the clean parse first, then the outermost {...} span, each strictly
 *  and then with those line breaks escaped. `null` when nothing parses to an object. */
export function parseModelJson(s: string): Record<string, unknown> | null {
  const cleaned = s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const a = cleaned.indexOf("{"),
    b = cleaned.lastIndexOf("}");
  const spans = [cleaned];
  if (a >= 0 && b > a) spans.push(cleaned.slice(a, b + 1));
  for (const span of spans)
    for (const attempt of [span, escapeControlsInStrings(span)]) {
      try {
        const v = JSON.parse(attempt);
        if (v && typeof v === "object" && !Array.isArray(v)) return v;
      } catch {
        /* next attempt */
      }
    }
  return null;
}

/** The enrichment payload, as far as it could be read. */
export interface ModelPayload {
  text: string;
  ambiguous?: unknown;
  tasks?: unknown;
  til?: unknown;
}

/**
 * Undo the ways a model mangles the "text" field of an enrichment answer: the whole JSON
 * answer nested inside it again (`{"text": "{\"text\": ...}"}`, or the raw object as a
 * string), and the `"""` fence the prompt wraps the entry in echoed back around it.
 * Nested payloads are unwrapped a few levels deep; the innermost `ambiguous`/`tasks`
 * win when the outer ones are empty, since that's where the model actually put them.
 */
export function unwrapModelPayload(p: ModelPayload): ModelPayload {
  let out = { ...p };
  for (let i = 0; i < 3; i++) {
    const t = out.text.trim();
    if (!t.startsWith("{") && !t.startsWith("```")) break;
    const inner = parseModelJson(t);
    if (!inner || typeof inner.text !== "string") break;
    const empty = (v: unknown) => !Array.isArray(v) || v.length === 0;
    out = {
      text: inner.text,
      ambiguous: empty(out.ambiguous)
        ? (inner.ambiguous ?? out.ambiguous)
        : out.ambiguous,
      tasks: empty(out.tasks) ? (inner.tasks ?? out.tasks) : out.tasks,
      til: out.til === true ? true : (inner.til ?? out.til),
    };
  }
  const fenced = out.text.trim().match(/^"""([\s\S]*)"""$/);
  if (fenced) out.text = (fenced[1] ?? "").trim();
  return out;
}
