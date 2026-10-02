import type { OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  type GroqChatFn,
  type GroqMessage,
  groqChat,
} from "../data/connections/groq.ts";
import type { DetectedTask } from "../domain/task/structures.ts";
import { isRecoverable } from "../libs/jot.ts";
import type { Candidate } from "../libs/links.ts";
import { logger } from "../libs/log.ts";
import {
  CircuitBreaker,
  parseModelJson,
  unwrapModelPayload,
} from "../libs/model.ts";
import {
  ENRICH_JSON_ONLY,
  SYSTEM,
  TASK_JSON_ONLY,
  TASK_SYSTEM,
  USE_OUTPUT_TOOL,
  VOICE_FIX_SYSTEM,
} from "./enrich-prompts.ts";

export type QueryFn = typeof sdkQuery;

/** OpenCode Go's OpenAI-compatible API root: the enrichment fallback's `baseUrl` and the
 *  health probe's `/models` listing both hang off it. */
export const OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";

/** OpenAI-compatible chat fallback used when the subscription SDK runs out of usage. */
export interface EnrichFallback {
  apiKey: string;
  model: string;
  baseUrl?: string;
  name?: string;
}

/** One model call's raw answer, before the caller reads it. */
type SdkOut = {
  text: string;
  usage: { input: number; output: number };
  structuredOutput?: unknown;
};

const log = logger("enrich");

/** Thrown when every step of the chain has its circuit open: nothing is worth calling
 *  until a cooldown runs out. The processor holds jots on this instead of burning a retry. */
export class ModelsDownError extends Error {
  constructor(cause: unknown) {
    super(
      `every enrichment model is down (last error: ${cause instanceof Error ? cause.message : String(cause)})`,
      { cause },
    );
    this.name = "ModelsDownError";
  }
}

// Which step answered last; DOWN when none could.
const DOWN = -1;

/** What a model-switch notice reports: a move down the chain, a recovery to the chosen
 *  model, or every step being down at once. */
export type SwitchTarget = "fallback" | "primary" | "down";

export type SwitchNotifier = (
  to: SwitchTarget,
  model: string,
  err?: unknown,
) => void | Promise<void>;

export interface EnrichInput {
  text: string;
  candidates: Candidate[];
  // The text is several quick messages sent moments apart (a squashed burst): weave
  // them into one flowing, well-punctuated entry rather than keeping them verbatim.
  merge?: boolean;
  // Character limit one journal entry gets split at. Passed so the model can mark topic
  // boundaries with blank lines when the text is over it. The split itself is done
  // deterministically in libs/text.ts, this only puts the seams on a change of subject.
  splitAt?: number;
}
export interface EnrichResult {
  text: string; // journal text with confident links applied inline
  ambiguous: Candidate[]; // links to confirm via Telegram buttons
  tasks: DetectedTask[]; // things to do, proposed for confirmation as tasks
  til: boolean; // the entry reads like something the author learned
  usage: { input: number; output: number };
}

const detectedTaskSchema = z.object({
  description: z.string(),
  start: z.string().optional(),
  due: z.string().optional(),
  type: z.string().optional(),
});

const TaskOutputStrict = z.strictObject({
  description: z.string(),
  start: z.string().optional(),
  due: z.string().optional(),
  type: z.enum(["work", "personal"]),
});

const ambiguousSchema = z.array(
  z.object({ surface: z.string(), note: z.string() }),
);
const tasksSchema = z.array(detectedTaskSchema);
/** Validates the agent's structured_output payload (the SDK's outputFormat already
 *  constrains the shape server-side; this guards against schema drift and the
 *  Groq fallback, which has no native structured-output support). */
const enrichedPayloadSchema = z.object({
  text: z.string(),
  ambiguous: ambiguousSchema,
  // Optional: the Groq fallback has no structured output to enforce this, and an answer
  // without the field is a valid answer — it just means "no tasks in this one".
  tasks: tasksSchema.optional(),
  til: z.boolean().optional(),
});

/** What the SDK's outputFormat asks the model for: every field present, nothing extra. A
 *  task inside an enrichment may leave its type out, which the lenient schemas above
 *  accept the same way. */
const EnrichOutputStrict = z.strictObject({
  text: z.string(),
  ambiguous: z.array(z.strictObject({ surface: z.string(), note: z.string() })),
  tasks: z.array(TaskOutputStrict.partial({ type: true })),
  til: z.boolean(),
});

/** The SDK takes raw JSON Schema without the `$schema` key zod adds. */
const outputFormat = (schema: z.ZodType): OutputFormat => {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema);
  return { type: "json_schema", schema: jsonSchema };
};

const TASK_OUTPUT_FORMAT = outputFormat(TaskOutputStrict);
const ENRICH_OUTPUT_FORMAT = outputFormat(EnrichOutputStrict);

export const userMessage = (content: unknown) => ({
  type: "user" as const,
  message: { role: "user" as const, content },
  parent_tool_use_id: null,
  session_id: "",
});

/** Strip the fence we wrap user text in, so content can't break out of the delimiter. */
const fence = (s: string): string => s.replaceAll('"""', "");

/** Enrichment via the Claude Agent SDK on subscription auth (CLAUDE_CODE_OAUTH_TOKEN
 *  in the environment) — no API key. One call per jot. */
export class Enricher {
  // Which step of the chain the last call ran on (0 = the chosen model). The user is
  // warned only when it changes: once on the way down, once on recovery, not per jot.
  private tier = 0;
  // One breaker per step, keyed by model/fallback name, so a step that keeps timing out
  // or erroring is skipped outright instead of costing every jot a wait on the way past.
  private breakers = new Map<string, CircuitBreaker>();

  constructor(
    private model: string | undefined,
    private query: QueryFn = sdkQuery,
    private fallbacks: EnrichFallback[] = [],
    private groqChatFn: GroqChatFn = groqChat,
    // Second Claude model, tried before the chat fallbacks when the chosen one fails.
    private backupModel?: string,
    // Hard cap on one model call. A call that hangs is a failure like any other.
    private timeoutMs = 15_000,
    private now: () => number = Date.now,
    // Who hears about a model switch; failures there never break enrichment (see announce).
    private notifySwitch?: SwitchNotifier,
  ) {}

  private breaker(name: string): CircuitBreaker {
    const found = this.breakers.get(name);
    if (found) return found;
    const created = new CircuitBreaker(3, 120_000, this.now);
    this.breakers.set(name, created);
    return created;
  }

  /** The Claude steps: `first`, then the backup model when it's a different one. */
  private models(first = this.model): (string | undefined)[] {
    if (this.backupModel && this.backupModel !== first)
      return [first, this.backupModel];
    return [first];
  }

  /** Names of every step of the chain, in the order they're tried. These are the
   *  breaker keys, so `run` names its steps the same way. */
  private chain(): string[] {
    return [
      ...this.models().map((model) => model ?? "default"),
      ...this.fallbacks.map((fb) => fb.name ?? fb.model),
    ];
  }

  /** False while every step's circuit is open: a call now would fail without trying
   *  anything, so the processor holds jots instead. Token-free. */
  available(): boolean {
    return this.chain().some((name) => this.breaker(name).allows());
  }

  /** Change the primary enrichment model at runtime (called when the user picks a
   *  new model from /menu). The next enrichment call uses the new value. */
  setModel(model: string): void {
    this.model = model;
  }

  private async announce(
    to: SwitchTarget,
    model: string,
    err?: unknown,
  ): Promise<void> {
    try {
      await this.notifySwitch?.(to, model, err);
    } catch (notifyErr) {
      log.warn(
        { err: notifyErr, to },
        "enrich: switch notifier threw (ignored)",
      );
    }
  }

  async enrich(input: EnrichInput): Promise<EnrichResult> {
    const cands = input.candidates.length
      ? input.candidates
          .map(
            (c) =>
              `- "${c.surface}" -> [[${c.note}]]${c.forced ? " (REGISTERED)" : ""}`,
          )
          .join("\n")
      : "(none)";
    // A squashed burst overrides the "keep English verbatim" rule: the fragments were
    // dashed off in seconds and need joining into one clean entry with real punctuation.
    const mergeNote = input.merge
      ? "\n\nThis entry arrived as several quick messages sent moments apart (each line below is one). Weave them into ONE coherent journal entry with correct punctuation and natural flow. Keep every point — do not summarise, drop, or reorder content."
      : "";
    // Over the limit the text becomes several journal entries, and the split is done on
    // blank lines first — so ask for those at the topic boundaries. Nothing else about the
    // text may change: the split itself stays deterministic and token-free.
    const splitNote =
      input.splitAt && input.text.length > input.splitAt
        ? `\n\nThis is longer than ${input.splitAt} characters and will be split into several separate journal entries. Put a blank line between distinct topics so the split lands on a change of subject. Add ONLY blank lines — do not summarise, drop, reorder, or reword anything. If it is all one topic, add none.`
        : "";
    const prompt = `Candidate links:\n${cands}${mergeNote}${splitNote}\n\nJournal text:\n"""${fence(input.text)}"""`;
    log.info(
      {
        candidates: input.candidates.length,
        chars: input.text.length,
        model: this.model ?? "default",
      },
      "enrich: calling agent",
    );
    // Parsed inside the chain: an unusable answer moves on to the next model.
    return this.run({
      prompt,
      system: SYSTEM,
      jsonTail: ENRICH_JSON_ONLY,
      outputFormat: ENRICH_OUTPUT_FORMAT,
      parse: ({ text, usage, structuredOutput }) =>
        this.parseEnriched(text, usage, structuredOutput),
    });
  }

  private parseEnriched(
    text: string,
    usage: { input: number; output: number },
    structuredOutput: unknown,
  ): EnrichResult {
    // Prefer the SDK's schema-validated structured output (only the primary model
    // supports it — the SDK retries internally before giving up). Fall back to
    // scraping JSON out of the free-text response for the Groq path, or for the rare
    // case the structured payload doesn't match our schema.
    const structured =
      structuredOutput === undefined
        ? undefined
        : enrichedPayloadSchema.safeParse(structuredOutput);
    if (structured && !structured.success)
      log.warn(
        { err: structured.error, structuredOutput },
        "enrich: structured_output failed schema validation, falling back to text parsing",
      );
    const raw: Record<string, unknown> | null =
      structured?.data ?? parseModelJson(text);

    if (typeof raw?.text !== "string" || !raw.text.trim())
      throw new Error(
        `enrichment returned no usable JSON: ${text.slice(0, 200)}`,
      );
    // A model can nest the whole answer inside "text" or echo the prompt's """ fence
    // around it; left alone, that JSON lands in the journal verbatim.
    const unwrapped = unwrapModelPayload(raw as { text: string });
    if (unwrapped.text !== raw.text)
      log.warn(
        { before: raw.text.slice(0, 200) },
        "enrich: model wrapped its answer inside text — unwrapped",
      );
    if (!unwrapped.text.trim())
      throw new Error(
        `enrichment returned an empty text: ${text.slice(0, 200)}`,
      );
    // The chat fallbacks have no schema enforcing these, so a malformed list is dropped
    // rather than trusted.
    const ambiguous = ambiguousSchema.safeParse(unwrapped.ambiguous).data ?? [];
    const tasks = tasksSchema.safeParse(unwrapped.tasks).data ?? [];
    const til = unwrapped.til === true;
    log.info(
      {
        usage,
        ambiguous: ambiguous.length,
        tasks: tasks.length,
        til,
        structured: structuredOutput !== undefined,
      },
      "enrich: agent responded",
    );
    return { text: unwrapped.text, ambiguous, tasks, til, usage };
  }

  /**
   * One line in, one task out: `/taskadd`'s reading of what you typed. The model's job is
   * comprehension — pulling the thing to do apart from when it is due, in whatever
   * language and however messily it was phrased — and explicitly NOT date arithmetic: it
   * reports the author's own words for the timing and chrono resolves them, the same rule
   * the jot suggestions follow. An explicit calendar date comes back as YYYY-MM-DD, which
   * needs no resolving either way.
   */
  async extractTask(text: string): Promise<DetectedTask> {
    const prompt = `Line:\n"""${fence(text)}"""`;
    log.info({ chars: text.length }, "extractTask: calling agent");
    return this.run({
      prompt,
      system: TASK_SYSTEM,
      jsonTail: TASK_JSON_ONLY,
      outputFormat: TASK_OUTPUT_FORMAT,
      parse: ({ text, structuredOutput }) =>
        this.parseTask(text, structuredOutput),
    });
  }

  private parseTask(raw: string, structuredOutput: unknown): DetectedTask {
    const parsed =
      detectedTaskSchema.safeParse(structuredOutput).data ??
      detectedTaskSchema.safeParse(parseModelJson(raw)).data;
    if (!parsed?.description)
      throw new Error(
        `task extraction returned no usable JSON: ${raw.slice(0, 200)}`,
      );
    log.info(
      {
        due: parsed.due ?? null,
        start: parsed.start ?? null,
        type: parsed.type,
      },
      "extractTask: agent responded",
    );
    return parsed;
  }

  /** Vision: caption an image that arrived without one. Returns a short caption. */
  async describeImage(bytes: Uint8Array, mediaType: string): Promise<string> {
    const data = Buffer.from(bytes).toString("base64");
    const caption =
      "Write a short, factual caption (max 12 words) for this image, for a personal journal. Return only the caption.";
    const prompt = (async function* () {
      yield userMessage([
        {
          type: "image",
          source: { type: "base64", media_type: mediaType, data },
        },
        { type: "text", text: caption },
      ]);
    })();
    log.debug(
      { mediaType, bytes: bytes.length },
      "describeImage: calling vision",
    );
    // SDK-only (run skips the chat fallbacks for a non-text prompt): Groq has no
    // production vision model, so there's no free fallback for captioning. If the SDK is
    // out of usage, degrade to no caption. The image still saves and embeds, just
    // without an AI-written display line.
    try {
      const { text } = await this.run({ prompt });
      log.debug({ caption: text.trim() }, "describeImage: got caption");
      return text.trim();
    } catch (err) {
      log.warn(
        { err },
        "describeImage: vision unavailable (usage out, no free vision fallback) — embedding uncaptioned",
      );
      return "";
    }
  }

  /**
   * Lightly fix a voice transcript: remove filler words, fix false starts and garbled
   * phrases, correct grammar — but keep the speaker's own words and meaning. Returns
   * the cleaned text, or the original unchanged when the model has nothing to fix.
   */
  async fixTranscript(text: string, model: string): Promise<string> {
    const prompt = `Voice transcript to clean up:\n"""${fence(text)}"""\n\nReturn ONLY the cleaned text, nothing else.`;
    log.info({ chars: text.length, model }, "fixTranscript: calling agent");
    const { text: fixed } = await this.run({
      prompt,
      system: VOICE_FIX_SYSTEM,
      model,
    });
    const result = fixed.trim() || text;
    log.info(
      { originalChars: text.length, fixedChars: result.length },
      "fixTranscript: done",
    );
    return result;
  }

  /** Apply a freeform edit instruction to an existing journal line's text. */
  async editText(current: string, instruction: string): Promise<string> {
    const prompt = `Current journal text:\n"""${fence(current)}"""\n\nEdit instruction: ${fence(instruction)}\n\nReturn ONLY the edited text, nothing else. Preserve voice and any [[wikilinks]] unless the edit changes them.`;
    log.debug({ instruction }, "editText: calling agent");
    const { text } = await this.run({ prompt });
    return text.trim() || current;
  }

  /** Single-turn call down the fallback chain: the chosen Claude model, then the backup
   *  Claude model, then the free Groq model. Each step runs only when the one before it
   *  throws (usage exhausted, overload, network) or answers something `parse` rejects.
   *  The Groq messages are built from the same `prompt` and `system`, with `jsonTail`
   *  appended to the system text because the chat fallbacks have no structured output. */
  private async run<T = SdkOut>({
    prompt,
    system,
    jsonTail = "",
    outputFormat,
    model: modelOverride,
    parse = (out) => out as T,
  }: {
    prompt: string | AsyncIterable<unknown>;
    system?: string;
    jsonTail?: string;
    outputFormat?: OutputFormat;
    model?: string;
    parse?: (out: SdkOut) => T;
  }): Promise<T> {
    const sdkSystem =
      system && outputFormat ? system + USE_OUTPUT_TOOL : system;
    const groqMessages: GroqMessage[] | undefined =
      typeof prompt === "string"
        ? [
            ...(system
              ? [{ role: "system" as const, content: system + jsonTail }]
              : []),
            { role: "user", content: prompt },
          ]
        : undefined;
    const steps: { name: string; call: () => Promise<SdkOut> }[] = [
      ...this.models(modelOverride ?? this.model).map((model) => ({
        name: model ?? "default",
        call: () => this.runSdk(prompt, sdkSystem, outputFormat, model),
      })),
      ...(groqMessages
        ? this.fallbacks.map((fb) => ({
            name: fb.name ?? fb.model,
            call: () =>
              this.groqChatFn(
                fb.apiKey,
                fb.model,
                groqMessages,
                fb.baseUrl,
                this.timeoutMs,
              ),
          }))
        : []),
    ];
    let lastErr: unknown;
    for (const [tier, step] of steps.entries()) {
      const breaker = this.breaker(step.name);
      if (!breaker.allows()) {
        lastErr ??= breaker.lastError;
        log.debug({ step: step.name }, "enrich: circuit open, skipping step");
        continue;
      }
      let raw: SdkOut;
      try {
        raw = await step.call();
      } catch (err) {
        // Only an outage trips the breaker. A rejected key still moves down the chain,
        // but opening a circuit on it would hold jots forever behind a failure no
        // cooldown can fix, instead of posting them un-enriched.
        if (isRecoverable(err)) breaker.failure(err);
        lastErr = err;
        log.warn({ err, step: step.name, tier }, "enrich: step failed");
        continue;
      }
      // It answered, so it's up. Whether the answer is usable is another question, and
      // one the breaker stays out of: a rejection quotes the answer, and "500 metres" in
      // it would read as a 5xx.
      breaker.success();
      try {
        const out = parse(raw);
        await this.settle(tier, step.name, lastErr);
        log.info(
          { step: step.name, tier, usage: raw.usage },
          "enrich: step answered",
        );
        return out;
      } catch (err) {
        lastErr = err;
        log.warn({ err, step: step.name, tier }, "enrich: unusable answer");
      }
    }
    if (this.available()) throw lastErr;
    if (this.tier !== DOWN) {
      log.error(
        { err: lastErr },
        "enrich: every model is down — holding jots until one is back",
      );
      this.tier = DOWN;
      await this.announce("down", "", lastErr);
    }
    throw new ModelsDownError(lastErr);
  }

  /** Record which step of the chain answered; warn the user only when that changes. */
  private async settle(
    tier: number,
    model: string,
    err?: unknown,
  ): Promise<void> {
    if (tier === this.tier) return;
    log.warn({ from: this.tier, to: tier, model }, "enrich: switching model");
    this.tier = tier;
    await this.announce(tier === 0 ? "primary" : "fallback", model, err);
  }

  /** One Claude Agent SDK call; collects assistant text and token usage. */
  private async runSdk(
    prompt: unknown,
    systemPrompt: string | undefined,
    outputFormat: OutputFormat | undefined,
    model: string | undefined,
  ): Promise<SdkOut> {
    // The abort kills the CLI subprocess; the race is what guarantees this returns even
    // if the stream never ends after it.
    const abortController = new AbortController();
    const timer = setTimeout(
      () =>
        abortController.abort(
          new Error(
            `timeout after ${this.timeoutMs / 1000}s (${model ?? "default"})`,
          ),
        ),
      this.timeoutMs,
    );
    const timedOut = new Promise<never>((_, reject) =>
      abortController.signal.addEventListener(
        "abort",
        () => reject(abortController.signal.reason),
        { once: true },
      ),
    );
    const consume = this.consume(
      prompt,
      systemPrompt,
      outputFormat,
      model,
      abortController,
    );
    consume.catch(() => {}); // after a timeout nothing awaits it; a late throw is noise
    try {
      return await Promise.race([consume, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async consume(
    prompt: unknown,
    systemPrompt: string | undefined,
    outputFormat: OutputFormat | undefined,
    model: string | undefined,
    abortController: AbortController,
  ): Promise<SdkOut> {
    let text = "";
    let structuredOutput: unknown;
    const usage = { input: 0, output: 0 };
    const stream = this.query({
      prompt: prompt as any,
      options: {
        // The StructuredOutput tool call is a turn of its own, plus one for the SDK to
        // re-ask a model that answered in text instead.
        maxTurns: outputFormat ? 3 : 1,
        allowedTools: [],
        abortController,
        // Linking a journal line needs no reasoning, and haiku's default thinking cost
        // 6-7s a call, pushing it past ENRICH_TIMEOUT_MS while the answer took under 1s.
        thinking: { type: "disabled" },
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(model ? { model } : {}),
        ...(outputFormat ? { outputFormat } : {}),
      },
    });
    for await (const msg of stream as AsyncIterable<any>) {
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? [])
          if (b.type === "text") text += b.text;
        const u = msg.message?.usage;
        if (u) {
          usage.input += u.input_tokens ?? 0;
          usage.output += u.output_tokens ?? 0;
        }
      } else if (msg.type === "result") {
        // A named error subtype (e.g. error_max_structured_output_retries) means
        // the SDK already retried against the schema server-side and gave up, and a
        // "success" with is_error set is an API error (529, 401…) carried in `result`.
        // Either is a failed call, so the next step in the chain kicks in.
        if (msg.is_error || (msg.subtype && msg.subtype !== "success"))
          throw new Error(
            `agent gave up producing a usable result (${msg.subtype}): ${msg.errors?.join("; ") || msg.result || ""}`,
          );
        if (typeof msg.result === "string" && !text) text = msg.result;
        if (msg.structured_output !== undefined)
          structuredOutput = msg.structured_output;
      }
    }
    return { text, usage, structuredOutput };
  }
}
