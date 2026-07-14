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
}
export interface EnrichResult {
	text: string; // journal text with confident links applied inline
	ambiguous: Candidate[]; // links to confirm via Telegram buttons
	usage: { input: number; output: number };
}

const SYSTEM = `You enrich personal journal entries for an Obsidian vault. Rules:
- The vault is English. If the text is not in English, translate it to natural English preserving the author's voice and meaning. If it is already English, keep it verbatim.
- Do not summarise or rewrite style. Other than translation, only insert wikilinks.
- You are given candidate wikilinks (surface text -> note). Apply a link ONLY when the surface word genuinely refers to that note IN THIS CONTEXT. A word matching a note alias is not enough (e.g. "no" is rarely the country Norway; "we" is rarely a book title).
- Candidates marked (REGISTERED) are hand-curated by the human: always link their first occurrence verbatim, with no contextual judgment — skip the ambiguity check entirely for those.
- Apply confident links inline using [[Note|surface]] (or [[Note]] if identical). Link the first occurrence only.
- For non-registered candidates you are unsure about, DO NOT link them; list them under "ambiguous" so the human can decide.
Your entire response must be exactly one JSON object and nothing else: {"text": "<final text>", "ambiguous": [{"surface":"...","note":"..."}]}
Do not write any preamble, explanation, commentary, or acknowledgement of the task before or after the JSON. Do not describe what you are about to do. The first character of your response must be "{" and the last character must be "}".`;

/** Validates the agent's structured_output payload (the SDK's outputFormat already
 *  constrains the shape server-side; this guards against schema drift and the
 *  Groq fallback, which has no native structured-output support). */
const enrichedPayloadSchema = z.object({
	text: z.string(),
	ambiguous: z.array(z.object({ surface: z.string(), note: z.string() })),
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
		},
		required: ["text", "ambiguous"],
		additionalProperties: false,
	},
};

/** Strip the fence we wrap user text in, so content can't break out of the delimiter. */
const fence = (s: string): string => s.replaceAll('"""', "");

/** A vault note action decided for one `@@instruction@@`: ensure `path` contains
 *  `content`, either only if it's missing ("create") or appended to it either way
 *  ("append"). Never an overwrite — the model can't destroy existing note content. */
export interface InstructionAction {
	path: string;
	content: string;
	mode: "create" | "append";
}
export interface InstructionResult {
	actions: InstructionAction[];
	reply: string; // short summary sent back to the user in Telegram
	usage: { input: number; output: number };
}

const INSTRUCTION_SYSTEM = `You act on side-instructions a user embedded in a personal journal message, marked with @@instruction@@. You are given the full original message for context — the @@ markers show which parts are instructions; everything else is the journal entry itself, for context only, never turned into an action on its own.
For each instruction, decide a vault note action:
- "create": write a NEW note only if one doesn't already exist at that path (no-op if it does) — for instructions like "create this note if it doesn't exist".
- "append": add content to the end of a note, creating it first if it doesn't exist — for instructions like "add this to my X".
Pick a sensible vault-relative note path from context (folders allowed, e.g. "Ideas/Weekend trip.md"). Never target the daily journal note itself — these are separate side notes only.
If an instruction doesn't clearly map to a note action, skip it (no action for it) and say why in "reply".
Your entire response must be exactly one JSON object and nothing else: {"actions":[{"path":"...","content":"...","mode":"create"|"append"}],"reply":"<short message to the user summarizing what you did>"}
Do not write any preamble, explanation, commentary, or acknowledgement of the task before or after the JSON. Do not describe what you are about to do. The first character of your response must be "{" and the last character must be "}".`;

const instructionPayloadSchema = z.object({
	actions: z.array(
		z.object({
			path: z.string(),
			content: z.string(),
			mode: z.enum(["create", "append"]),
		}),
	),
	reply: z.string(),
});

const INSTRUCTION_OUTPUT_FORMAT: OutputFormat = {
	type: "json_schema",
	schema: {
		type: "object",
		properties: {
			actions: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						content: { type: "string" },
						mode: { type: "string", enum: ["create", "append"] },
					},
					required: ["path", "content", "mode"],
					additionalProperties: false,
				},
			},
			reply: { type: "string" },
		},
		required: ["actions", "reply"],
		additionalProperties: false,
	},
};

/** Enrichment via the Claude Agent SDK on subscription auth (CLAUDE_CODE_OAUTH_TOKEN
 *  in the environment) — no API key. One call per jot. */
export class Enricher {
	// Which model the last call ran on. Flips only on a *transition*, so the user is
	// warned once when usage runs out and once when it comes back — not per jot.
	private usingFallback = false;
	private notifySwitch?: (
		to: "fallback" | "primary",
		model: string,
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
		fn: (to: "fallback" | "primary", model: string) => void | Promise<void>,
	): void {
		this.notifySwitch = fn;
	}

	private async announce(
		to: "fallback" | "primary",
		model: string,
	): Promise<void> {
		try {
			await this.notifySwitch?.(to, model);
		} catch (err) {
			log.warn({ err, to }, "enrich: switch notifier threw (ignored)");
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
		const prompt = `Candidate links:\n${cands}${mergeNote}\n\nJournal text:\n"""${fence(input.text)}"""`;
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
		let parsed: { text?: string; ambiguous?: Candidate[] } | null = null;
		if (structuredOutput !== undefined) {
			const result = enrichedPayloadSchema.safeParse(structuredOutput);
			if (result.success) parsed = result.data;
			else
				log.warn(
					{ err: result.error, structuredOutput },
					"enrich: structured_output failed schema validation, falling back to text parsing",
				);
		}
		if (!parsed)
			parsed = this.extractJson<{ text?: string; ambiguous?: Candidate[] }>(
				text,
			);

		if (!parsed?.text)
			throw new Error(
				`enrichment returned no usable JSON: ${text.slice(0, 200)}`,
			);
		log.info(
			{
				usage,
				ambiguous: parsed.ambiguous?.length ?? 0,
				structured: structuredOutput !== undefined,
			},
			"enrich: agent responded",
		);
		return { text: parsed.text, ambiguous: parsed.ambiguous ?? [], usage };
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

	/** Decide what to do about a jot's `@@instruction@@`(s): given the full original
	 *  message (for positional context — what "this" refers to) and the isolated
	 *  instruction fragments, returns the note action(s) to apply and a short reply for
	 *  the user. Execution itself is deterministic and happens in the caller (the
	 *  processor); the agent only decides intent. */
	async runInstructions(
		fullText: string,
		instructions: string[],
	): Promise<InstructionResult> {
		const marked = instructions
			.map((ins, i) => `${i + 1}. ${fence(ins)}`)
			.join("\n");
		const prompt = `Full original message:\n"""${fence(fullText)}"""\n\nInstructions to act on:\n${marked}`;
		log.info({ count: instructions.length }, "runInstructions: calling agent");
		const { text, usage, structuredOutput } = await this.run(
			prompt,
			INSTRUCTION_SYSTEM,
			[
				{ role: "system", content: INSTRUCTION_SYSTEM },
				{ role: "user", content: prompt },
			],
			INSTRUCTION_OUTPUT_FORMAT,
		);

		let parsed: { actions?: InstructionAction[]; reply?: string } | null = null;
		if (structuredOutput !== undefined) {
			const result = instructionPayloadSchema.safeParse(structuredOutput);
			if (result.success) parsed = result.data;
			else
				log.warn(
					{ err: result.error, structuredOutput },
					"runInstructions: structured_output failed schema validation, falling back to text parsing",
				);
		}
		if (!parsed)
			parsed = this.extractJson<{
				actions?: InstructionAction[];
				reply?: string;
			}>(text);
		if (!parsed)
			throw new Error(
				`instruction run returned no usable JSON: ${text.slice(0, 200)}`,
			);
		log.info(
			{ actions: parsed.actions?.length ?? 0, usage },
			"runInstructions: agent responded",
		);
		return { actions: parsed.actions ?? [], reply: parsed.reply ?? "", usage };
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
			// SDK worked. If we were on the fallback, usage has recovered — flip back + warn.
			if (this.usingFallback) {
				this.usingFallback = false;
				log.info(
					{ model: this.model ?? "default" },
					"enrich: subscription usage recovered — back on the primary model",
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
				await this.announce("fallback", this.fallback.model);
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
	// outermost {...} span only if that fails. Generic: shared by enrich() and
	// runInstructions(), which parse differently-shaped payloads.
	private extractJson<T>(s: string): T | null {
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
