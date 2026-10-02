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

export interface ModelPayload {
  text: string;
  ambiguous?: unknown;
  tasks?: unknown;
  til?: unknown;
}

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
