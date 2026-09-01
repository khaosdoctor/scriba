import type { OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import Groq from "groq-sdk";
import { z } from "zod";
import type { Candidate } from "../core.ts";
import { logger } from "../log.ts";

export type QueryFn = typeof sdkQuery;

/** Free-model fallback used when the subscription SDK runs out of usage. */
export interface EnrichFallback {
	apiKey: string;
	model: string;
}

/** OpenAI-shaped chat message (what the Groq SDK takes). Content is a string for
 *  text turns, or a content-part array for the vision (image) turn. */
type GroqMessage = { role: "system" | "user"; content: unknown };

/** The Groq chat call, injectable for tests (mirrors the SDK `query` seam). */
export type GroqChatFn = (
	apiKey: string,
	model: string,
	messages: GroqMessage[],
) => Promise<{ text: string; usage: { input: number; output: number } }>;

const groqChat: GroqChatFn = async (apiKey, model, messages) => {
	const groq = new Groq({ apiKey });
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
Your entire response must be exactly one JSON object and nothing else: {"text": "<final text>", "ambiguous": [{"surface":"...","note":"..."}], "tasks": [{"description":"...","due":"...","type":"personal"}]}
Do not write any preamble, explanation, commentary, or acknowledgement of the task before or after the JSON. Do not describe what you are about to do. The first character of your response must be "{" and the last character must be "}".`;

const TASK_SYSTEM = `You turn one line of text into a task for a personal task list. Rules:
- "description": what has to be done, in English, as a short instruction. Keep the author's own specifics — names, links, numbers, [[wikilinks]] — verbatim. Leave the timing words out of it.
- "due" is the deadline and "start" is when work on it begins. Copy each one VERBATIM from the line, exactly as the author phrased the timing ("next friday", "amanhã", "by the 15th", "på fredag"). Do NOT convert them to a date and do NOT calculate anything: you are not told what today is. Omit a field entirely when the line says nothing about it — never invent one.
- The one exception: if the line already gives an explicit calendar date, give it as YYYY-MM-DD.
- A line that mentions only one time is giving you a deadline: put it in "due", not "start".
- "type": "personal" unless the line plainly puts the task at work — a colleague, a work project, the office, or the author saying it is for work. If you are weighing it up at all, it is "personal": the author sorts work from personal by hand in one tap, and a personal task filed as work goes into the wrong note.
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

/** Validates the agent's structured_output payload (the SDK's outputFormat already
 *  constrains the shape server-side; this guards against schema drift and the
 *  Groq fallback, which has no native structured-output support). */
const enrichedPayloadSchema = z.object({
	text: z.string(),
	ambiguous: z.array(z.object({ surface: z.string(), note: z.string() })),
	// Optional: the Groq fallback has no structured output to enforce this, and an answer
	// without the field is a valid answer — it just means "no tasks in this one".
	tasks: z
		.array(
			z.object({
				description: z.string(),
				start: z.string().optional(),
				due: z.string().optional(),
				type: z.string().optional(),
			}),
		)
		.optional(),
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
	// Which model the last call ran on. Flips only on a *transition*, so the user is
	// warned once when usage runs out and once when it comes back — not per jot.
	private usingFallback = false;
	private notifySwitch?: (
		to: "fallback" | "primary",
		model: string,
		err?: unknown,
	) => void | Promise<void>;

	constructor(
		private model = process.env.AGENT_MODEL,
		private query: QueryFn = sdkQuery,
		private fallback?: EnrichFallback,
		private groqChatFn: GroqChatFn = groqChat,
	) {}

	/** Late-wired (bot exists after the enricher): called on each model switch so the
	 *  bot can warn the user in Telegram. Failures here never break enrichment. */
	setSwitchNotifier(
		fn: (
			to: "fallback" | "primary",
			model: string,
			err?: unknown,
		) => void | Promise<void>,
	): void {
		this.notifySwitch = fn;
	}

	private async announce(
		to: "fallback" | "primary",
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
		const { text, usage, structuredOutput } = await this.run(
			prompt,
			SYSTEM,
			[
				{ role: "system", content: SYSTEM },
				{ role: "user", content: prompt },
			],
			ENRICH_OUTPUT_FORMAT,
		);

		// Prefer the SDK's schema-validated structured output (only the primary model
		// supports it — the SDK retries internally before giving up). Fall back to
		// scraping JSON out of the free-text response for the Groq path, or for the rare
		// case the structured payload doesn't match our schema.
		let parsed: {
			text?: string;
			ambiguous?: Candidate[];
			tasks?: DetectedTask[];
		} | null = null;
		if (structuredOutput !== undefined) {
			const result = enrichedPayloadSchema.safeParse(structuredOutput);
			if (result.success) parsed = result.data;
			else
				log.warn(
					{ err: result.error, structuredOutput },
					"enrich: structured_output failed schema validation, falling back to text parsing",
				);
		}
		if (!parsed) parsed = this.extractJson(text);

		if (!parsed?.text)
			throw new Error(
				`enrichment returned no usable JSON: ${text.slice(0, 200)}`,
			);
		log.info(
			{
				usage,
				ambiguous: parsed.ambiguous?.length ?? 0,
				tasks: parsed.tasks?.length ?? 0,
				structured: structuredOutput !== undefined,
			},
			"enrich: agent responded",
		);
		return {
			text: parsed.text,
			ambiguous: parsed.ambiguous ?? [],
			tasks: parsed.tasks ?? [],
			usage,
		};
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
		const { text: raw, structuredOutput } = await this.run(
			prompt,
			TASK_SYSTEM,
			[
				{ role: "system", content: TASK_SYSTEM },
				{ role: "user", content: prompt },
			],
			TASK_OUTPUT_FORMAT,
		);
		const parsed =
			(structuredOutput !== undefined
				? detectedTaskSchema.safeParse(structuredOutput)
				: { success: false as const, data: undefined }
			).data ?? detectedTaskSchema.safeParse(this.extractJson(raw)).data;
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

	/** Apply a freeform edit instruction to an existing journal line's text. */
	async editText(current: string, instruction: string): Promise<string> {
		const prompt = `Current journal text:\n"""${fence(current)}"""\n\nEdit instruction: ${fence(instruction)}\n\nReturn ONLY the edited text, nothing else. Preserve voice and any [[wikilinks]] unless the edit changes them.`;
		log.debug({ instruction }, "editText: calling agent");
		const { text } = await this.run(prompt, undefined, [
			{ role: "user", content: prompt },
		]);
		return text.trim() || current;
	}

	/** Single-turn agent call; collects assistant text and token usage. When the
	 *  subscription SDK errors (usage exhausted, overload, network) and a Groq fallback
	 *  is configured, retries the same request on the free model. `groqMessages` is the
	 *  same prompt in OpenAI chat shape — omit it to keep a call SDK-only. */
	private async run(
		prompt: unknown,
		systemPrompt?: string,
		groqMessages?: GroqMessage[],
		outputFormat?: OutputFormat,
	): Promise<{
		text: string;
		usage: { input: number; output: number };
		structuredOutput?: unknown;
	}> {
		try {
			let text = "";
			let structuredOutput: unknown;
			const usage = { input: 0, output: 0 };
			const stream = this.query({
				prompt: prompt as any,
				options: {
					maxTurns: 1,
					allowedTools: [],
					...(systemPrompt ? { systemPrompt } : {}),
					...(this.model ? { model: this.model } : {}),
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
					// the SDK already retried against the schema server-side and gave up —
					// treat it as a failed call so the Groq fallback / give-up path kicks in.
					if (msg.subtype && msg.subtype !== "success")
						throw new Error(
							`agent gave up producing a usable result (${msg.subtype})`,
						);
					if (typeof msg.result === "string" && !text) text = msg.result;
					if (msg.structured_output !== undefined)
						structuredOutput = msg.structured_output;
				}
			}
			// SDK worked. If we were on the fallback, the primary model recovered — flip
			// back + warn. (The earlier failure may or may not have been usage exhaustion —
			// see the `err` logged when we switched to fallback for the actual cause.)
			if (this.usingFallback) {
				this.usingFallback = false;
				log.info(
					{ model: this.model ?? "default" },
					"enrich: primary model recovered — switching back from Groq fallback",
				);
				await this.announce("primary", this.model ?? "default");
			}
			return { text, usage, structuredOutput };
		} catch (err) {
			if (!this.fallback || !groqMessages) throw err;
			if (!this.usingFallback) {
				this.usingFallback = true;
				log.warn(
					{ err, fallbackModel: this.fallback.model },
					"enrich: subscription SDK failed — switching to the free Groq model",
				);
				await this.announce("fallback", this.fallback.model, err);
			} else {
				log.warn(
					{ err, fallbackModel: this.fallback.model },
					"enrich: agent SDK still failing — staying on the free Groq model",
				);
			}
			const out = await this.groqChatFn(
				this.fallback.apiKey,
				this.fallback.model,
				groqMessages,
			);
			log.info(
				{ model: this.fallback.model, usage: out.usage },
				"enrich: Groq fallback done",
			);
			return out;
		}
	}

	// The agent returns free-form text: usually clean JSON, occasionally wrapped in a
	// ```json fence or a stray sentence. Try the clean parse first; fall back to the
	// outermost {...} span only if that fails.
	private extractJson(
		s: string,
	): { text?: string; ambiguous?: Candidate[]; tasks?: DetectedTask[] } | null {
		const cleaned = s
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "")
			.trim();
		try {
			return JSON.parse(cleaned);
		} catch {
			/* fall through */
		}
		const a = cleaned.indexOf("{"),
			b = cleaned.lastIndexOf("}");
		if (a >= 0 && b > a) {
			try {
				return JSON.parse(cleaned.slice(a, b + 1));
			} catch {
				/* give up */
			}
		}
		return null;
	}
}
