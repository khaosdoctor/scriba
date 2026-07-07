import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import Groq from "groq-sdk";
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
- Apply confident links inline using [[Note|surface]] (or [[Note]] if identical). Link the first occurrence only.
- For candidates you are unsure about, DO NOT link them; list them under "ambiguous" so the human can decide.
Respond with ONLY a JSON object: {"text": "<final text>", "ambiguous": [{"surface":"...","note":"..."}]}`;

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
					.map((c) => `- "${c.surface}" -> [[${c.note}]]`)
					.join("\n")
			: "(none)";
		const prompt = `Candidate links:\n${cands}\n\nJournal text:\n"""${fence(input.text)}"""`;
		log.info(
			{
				candidates: input.candidates.length,
				chars: input.text.length,
				model: this.model ?? "default",
			},
			"enrich: calling agent",
		);
		const { text, usage } = await this.run(prompt, SYSTEM, [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: prompt },
		]);

		const parsed = this.extractJson(text);
		if (!parsed?.text)
			throw new Error(
				`enrichment returned no usable JSON: ${text.slice(0, 200)}`,
			);
		log.info(
			{ usage, ambiguous: parsed.ambiguous?.length ?? 0 },
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

	/** Single-turn agent call; collects assistant text and token usage. When the
	 *  subscription SDK errors (usage exhausted, overload, network) and a Groq fallback
	 *  is configured, retries the same request on the free model. `groqMessages` is the
	 *  same prompt in OpenAI chat shape — omit it to keep a call SDK-only. */
	private async run(
		prompt: unknown,
		systemPrompt?: string,
		groqMessages?: GroqMessage[],
	): Promise<{ text: string; usage: { input: number; output: number } }> {
		try {
			let text = "";
			const usage = { input: 0, output: 0 };
			const stream = this.query({
				prompt: prompt as any,
				options: {
					maxTurns: 1,
					allowedTools: [],
					...(systemPrompt ? { systemPrompt } : {}),
					...(this.model ? { model: this.model } : {}),
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
				} else if (
					msg.type === "result" &&
					typeof msg.result === "string" &&
					!text
				) {
					text = msg.result;
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
			return { text, usage };
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
	// outermost {...} span only if that fails.
	private extractJson(
		s: string,
	): { text?: string; ambiguous?: Candidate[] } | null {
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
