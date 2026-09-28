import type { OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import Groq from "groq-sdk";
import { z } from "zod";
import {
  type Candidate,
  CircuitBreaker,
  isRecoverable,
  parseModelJson,
  unwrapModelPayload,
} from "../core.ts";
import { logger } from "../log.ts";

export type QueryFn = typeof sdkQuery;

/** OpenAI-compatible chat fallback used when the subscription SDK runs out of usage. */
export interface EnrichFallback {
  apiKey: string;
  model: string;
  baseUrl?: string;
  name?: string;
}

/** OpenAI-shaped chat message (what the Groq SDK takes). Content is a string for
 *  text turns, or a content-part array for the vision (image) turn. */
type GroqMessage = { role: "system" | "user"; content: unknown };

/** One model call's raw answer, before the caller reads it. */
type SdkOut = {
  text: string;
  usage: { input: number; output: number };
  structuredOutput?: unknown;
};

/** OpenAI-compatible chat call, injectable for tests (mirrors the SDK `query` seam). */
export type GroqChatFn = (
  apiKey: string,
  model: string,
  messages: GroqMessage[],
  baseUrl?: string,
  timeoutMs?: number,
) => Promise<{ text: string; usage: { input: number; output: number } }>;

const groqChat: GroqChatFn = async (
  apiKey,
  model,
  messages,
  baseUrl,
  timeoutMs,
) => {
  // No SDK retries: the next tier is the retry, and three timed-out attempts would hold
  // the jot three times as long before it got there.
  const groq = new Groq({
    apiKey,
    maxRetries: 0,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  });
  const res = await groq.chat.completions.create({
    model,
    temperature: 0,
    messages: messages as any,
  });
  return {
    text: res.choices[0]?.message?.content ?? "",
    usage: {
      input: res.usage?.prompt_tokens ?? 0,
      output: res.usage?.completion_tokens ?? 0,
    },
  };
};

const log = logger("enrich");

/** Thrown when every step of the chain has its circuit open: nothing is worth calling
 *  until a cooldown runs out. The processor holds jots on this instead of burning a retry. */
export class ModelsDownError extends Error {
  constructor(cause: unknown) {
    super(
      `every enrichment model is down (last error: ${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "ModelsDownError";
  }
}

// Which step answered last; DOWN when none could.
const DOWN = -1;

/** What a model-switch notice reports: a move down the chain, a recovery to the chosen
 *  model, or every step being down at once. */
export type SwitchTarget = "fallback" | "primary" | "down";

export interface EnrichInput {
  text: string;
  candidates: Candidate[];
  // The text is several quick messages sent moments apart (a squashed burst): weave
  // them into one flowing, well-punctuated entry rather than keeping them verbatim.
  merge?: boolean;
  // Character limit one journal entry gets split at. Passed so the model can mark topic
  // boundaries with blank lines when the text is over it — the split itself is done
  // deterministically in core.ts, this only makes the seams land on a change of subject.
  splitAt?: number;
}
/** A task the entry says the author still has to do. The dates are the author's own words
 *  ("next friday", "by the 15th"), resolved against the jot's day by chrono — the model is
 *  never asked what today is, and never asked to do date arithmetic. */
export interface DetectedTask {
  description: string;
  start?: string;
  due?: string;
  type?: string;
}

export interface EnrichResult {
  text: string; // journal text with confident links applied inline
  ambiguous: Candidate[]; // links to confirm via Telegram buttons
  tasks: DetectedTask[]; // things to do, proposed for confirmation as tasks
  usage: { input: number; output: number };
}

const SYSTEM = `You enrich personal journal entries for an Obsidian vault. Rules:
- The vault is English. If the text is not in English, translate it to natural English preserving the author's voice and meaning. If it is already English, keep it verbatim.
- Do not summarise or rewrite style. Other than translation, only insert wikilinks.
- You are given candidate wikilinks (surface text -> note). Apply a link ONLY when the surface word genuinely refers to that note IN THIS CONTEXT. A word matching a note alias is not enough (e.g. "no" is rarely the country Norway; "we" is rarely a book title).
- Candidates marked (REGISTERED) are hand-curated by the human: always link their first occurrence verbatim, with no contextual judgment — skip the ambiguity check entirely for those.
- Apply confident links inline using [[Note|surface]] (or [[Note]] if identical). Link the first occurrence only.
- For non-registered candidates you are unsure about, DO NOT link them; list them under "ambiguous" so the human can decide.
- YEARS: the vault has a note per year, so link every year the entry mentions even though years are never in the candidate list. A year of the common era links as [[1918]]; a year before it links as [[146 BCE]] — always "BCE", never "BC" or "AD". Link every mention, not only the first.
- Only you can tell a year from a number that looks like one, which is why this is your job and not a regex: "1500 metres", "3000 steps" and "2000 calories" are quantities, while "in 1500 the city fell" is a year. Judge it from the sentence. Never link a decade ("the 1920s"), a clock time ("19:18"), a version ("1.35.0"), a quantity, or a date that is already a link.
- TASKS: if the entry says the author still has to DO something — a commitment, an errand, a plan, anything phrased as needing or intending to do it — list it under "tasks". Something already done is not a task, and neither is an idle wish with no intent. Most entries contain none: return an empty list then, and never turn the entry itself into a task.
- Each task has a "description" (what to do, in English, as a short instruction), an optional "due" and "start", and a "type", which is "personal" unless the entry plainly puts it at work — a colleague, a work project, the office, or the author saying it is for work. Anything you are unsure about is "personal". Copy "due"/"start" VERBATIM from the entry as the author phrased the timing ("next friday", "tomorrow", "by the 15th") — do not convert them to a date, do not calculate anything, and omit them entirely when the entry says nothing about when.
- "text" is the journal entry itself, plain prose with its wikilinks — never JSON.
- Each "ambiguous" entry copies one candidate exactly: "surface" is its surface text and "note" is its note name, with no explanation.`;

// Only the chat fallbacks get this: they have no structured output, so JSON-as-text is
// the answer. Given to the SDK it fights the StructuredOutput tool — haiku writes the
// JSON as text and runs out of turns, sonnet nests the whole JSON inside "text".
const ENRICH_JSON_ONLY = `
Your entire response must be exactly one JSON object and nothing else: {"text": "<final text>", "ambiguous": [{"surface":"...","note":"..."}], "tasks": [{"description":"...","due":"...","type":"personal"}]}
Do not write any preamble, explanation, commentary, or acknowledgement of the task before or after the JSON. Do not describe what you are about to do. The first character of your response must be "{" and the last character must be "}".`;

/** SDK-side counterpart of the JSON-only tails, for calls that pass an outputFormat. */
const USE_OUTPUT_TOOL = `
Give your answer only by calling the StructuredOutput tool, with each field holding its own value. Write no text.`;

const VOICE_FIX_SYSTEM = `You lightly clean up a voice-to-text transcript for a personal journal. Rules:
- Fix obvious transcription errors, filler words (um, uh, like, you know), false starts, and repeated words.
- Correct grammar and punctuation so it reads as natural written text.
- KEEP the speaker's own words, vocabulary, and meaning. Do not paraphrase, summarise, or rewrite.
- Do not add information, context, or commentary. Do not change the tone or voice.
- If the transcript is already clean, return it unchanged.
- Return ONLY the cleaned text, nothing else — no preamble, no explanation.`;

const TASK_SYSTEM = `You turn one line of text into a task for a personal task list. Rules:
- "description": what has to be done, in English, as a short instruction. Keep the author's own specifics — names, links, numbers, [[wikilinks]] — verbatim. Leave the timing words out of it.
- "due" is the deadline and "start" is when work on it begins. Copy each one VERBATIM from the line, exactly as the author phrased the timing ("next friday", "amanhã", "by the 15th", "på fredag"). Do NOT convert them to a date and do NOT calculate anything: you are not told what today is. Omit a field entirely when the line says nothing about it — never invent one.
- The one exception: if the line already gives an explicit calendar date, give it as YYYY-MM-DD.
- A line that mentions only one time is giving you a deadline: put it in "due", not "start".
- "type": "personal" unless the line plainly puts the task at work — a colleague, a work project, the office, or the author saying it is for work. If you are weighing it up at all, it is "personal": the author sorts work from personal by hand in one tap, and a personal task filed as work goes into the wrong note.`;

const TASK_JSON_ONLY = `
Your entire response must be exactly one JSON object and nothing else: {"description": "...", "due": "...", "start": "...", "type": "personal"}
Do not write any preamble, explanation or commentary. The first character of your response must be "{" and the last character must be "}".`;

const detectedTaskSchema = z.object({
  description: z.string(),
  start: z.string().optional(),
  due: z.string().optional(),
  type: z.string().optional(),
});

/** JSON Schema twin of detectedTaskSchema, for the SDK's outputFormat. */
const TASK_OUTPUT_FORMAT: OutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      description: { type: "string" },
      start: { type: "string" },
      due: { type: "string" },
      type: { type: "string", enum: ["work", "personal"] },
    },
    required: ["description", "type"],
    additionalProperties: false,
  },
};

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
});

/** JSON Schema twin of enrichedPayloadSchema, for the SDK's outputFormat request param
 *  (which takes raw JSON Schema, not a Zod schema). Keep the two in sync by hand — the
 *  shape is small and stable. */
const ENRICH_OUTPUT_FORMAT: OutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      ambiguous: {
        type: "array",
        items: {
          type: "object",
          properties: {
            surface: { type: "string" },
            note: { type: "string" },
          },
          required: ["surface", "note"],
          additionalProperties: false,
        },
      },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            start: { type: "string" },
            due: { type: "string" },
            type: { type: "string", enum: ["work", "personal"] },
          },
          required: ["description"],
          additionalProperties: false,
        },
      },
    },
    required: ["text", "ambiguous", "tasks"],
    additionalProperties: false,
  },
};

/** Strip the fence we wrap user text in, so content can't break out of the delimiter. */
const fence = (s: string): string => s.replaceAll('"""', "");

/** Enrichment via the Claude Agent SDK on subscription auth (CLAUDE_CODE_OAUTH_TOKEN
 *  in the environment) — no API key. One call per jot. */
export class Enricher {
  // Which step of the chain the last call ran on (0 = the chosen model). The user is
  // warned only when it changes: once on the way down, once on recovery, not per jot.
  private tier = 0;
  private notifySwitch?: (
    to: SwitchTarget,
    model: string,
    err?: unknown,
  ) => void | Promise<void>;
  // One breaker per step, keyed by model/fallback name, so a step that keeps timing out
  // or erroring is skipped outright instead of costing every jot a wait on the way past.
  private breakers = new Map<string, CircuitBreaker>();

  constructor(
    private model = process.env.AGENT_MODEL,
    private query: QueryFn = sdkQuery,
    private fallbacks: EnrichFallback[] = [],
    private groqChatFn: GroqChatFn = groqChat,
    // Second Claude model, tried before the chat fallbacks when the chosen one fails.
    private backupModel?: string,
    // Hard cap on one model call. A call that hangs is a failure like any other.
    private timeoutMs = 15_000,
    private now: () => number = Date.now,
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

  /** Late-wired (bot exists after the enricher): called on each model switch so the
   *  bot can warn the user in Telegram. Failures here never break enrichment. */
  setSwitchNotifier(
    fn: (
      to: SwitchTarget,
      model: string,
      err?: unknown,
    ) => void | Promise<void>,
  ): void {
    this.notifySwitch = fn;
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
    return this.run(
      prompt,
      SYSTEM + USE_OUTPUT_TOOL,
      [
        { role: "system", content: SYSTEM + ENRICH_JSON_ONLY },
        { role: "user", content: prompt },
      ],
      ENRICH_OUTPUT_FORMAT,
      undefined,
      ({ text, usage, structuredOutput }) =>
        this.parseEnriched(text, usage, structuredOutput),
    );
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
    log.info(
      {
        usage,
        ambiguous: ambiguous.length,
        tasks: tasks.length,
        structured: structuredOutput !== undefined,
      },
      "enrich: agent responded",
    );
    return { text: unwrapped.text, ambiguous, tasks, usage };
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
    return this.run(
      prompt,
      TASK_SYSTEM + USE_OUTPUT_TOOL,
      [
        { role: "system", content: TASK_SYSTEM + TASK_JSON_ONLY },
        { role: "user", content: prompt },
      ],
      TASK_OUTPUT_FORMAT,
      undefined,
      ({ text, structuredOutput }) => this.parseTask(text, structuredOutput),
    );
  }

  private parseTask(raw: string, structuredOutput: unknown): DetectedTask {
    const parsed =
      (structuredOutput !== undefined
        ? detectedTaskSchema.safeParse(structuredOutput)
        : { success: false as const, data: undefined }
      ).data ?? detectedTaskSchema.safeParse(parseModelJson(raw)).data;
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
      yield {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data },
            },
            { type: "text", text: caption },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      };
    })();
    log.debug(
      { mediaType, bytes: bytes.length },
      "describeImage: calling vision",
    );
    // SDK-only, no groqMessages: Groq has no production vision model, so there's no
    // free fallback for captioning. If the SDK is out of usage, degrade to no caption —
    // the image still saves and embeds, just without an AI-written display line.
    try {
      const { text } = await this.run(prompt as any);
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
    const { text: fixed } = await this.run(
      prompt,
      VOICE_FIX_SYSTEM,
      [
        { role: "system", content: VOICE_FIX_SYSTEM },
        { role: "user", content: prompt },
      ],
      undefined,
      model,
    );
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
    const { text } = await this.run(prompt, undefined, [
      { role: "user", content: prompt },
    ]);
    return text.trim() || current;
  }

  /** Single-turn call down the fallback chain: the chosen Claude model, then the backup
   *  Claude model, then the free Groq model. Each step runs only when the one before it
   *  throws (usage exhausted, overload, network) or answers something `parse` rejects.
   *  `groqMessages` is the same prompt in OpenAI chat shape — omit it to keep a call
   *  Claude-only (vision has no Groq model). */
  private async run<T = SdkOut>(
    prompt: unknown,
    systemPrompt?: string,
    groqMessages?: GroqMessage[],
    outputFormat?: OutputFormat,
    modelOverride?: string,
    parse: (out: SdkOut) => T = (out) => out as T,
  ): Promise<T> {
    const steps: { name: string; call: () => Promise<SdkOut> }[] = [
      ...this.models(modelOverride ?? this.model).map((model) => ({
        name: model ?? "default",
        call: () => this.runSdk(prompt, systemPrompt, outputFormat, model),
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
      try {
        const raw = await step.call();
        const out = parse(raw);
        breaker.success();
        await this.settle(tier, step.name, lastErr);
        log.info(
          { step: step.name, tier, usage: raw.usage },
          "enrich: step answered",
        );
        return out;
      } catch (err) {
        // Only an outage trips the breaker. An unusable answer or a rejected key still
        // moves down the chain, but opening a circuit on it would hold jots forever
        // behind a failure no cooldown can fix, instead of posting them un-enriched.
        if (isRecoverable(err)) breaker.failure(err);
        lastErr = err;
        log.warn({ err, step: step.name, tier }, "enrich: step failed");
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
