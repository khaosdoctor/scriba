import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Candidate } from "./core.ts";

export interface EnrichInput {
  text: string;
  candidates: Candidate[];
}
export interface EnrichResult {
  text: string;                 // journal text with confident links applied inline
  ambiguous: Candidate[];       // links to confirm via Telegram buttons
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
  constructor(private model = process.env.AGENT_MODEL) {}

  async enrich(input: EnrichInput): Promise<EnrichResult> {
    const cands = input.candidates.length
      ? input.candidates.map((c) => `- "${c.surface}" -> [[${c.note}]]`).join("\n")
      : "(none)";
    const prompt = `Candidate links:\n${cands}\n\nJournal text:\n"""${fence(input.text)}"""`;
    const { text, usage } = await this.run(prompt, SYSTEM);

    const parsed = this.extractJson(text);
    if (!parsed?.text) throw new Error(`enrichment returned no usable JSON: ${text.slice(0, 200)}`);
    return { text: parsed.text, ambiguous: parsed.ambiguous ?? [], usage };
  }

  /** Vision: caption an image that arrived without one. Returns a short caption. */
  async describeImage(bytes: Uint8Array, mediaType: string): Promise<string> {
    const data = Buffer.from(bytes).toString("base64");
    const prompt = (async function* () {
      yield {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data } },
            { type: "text", text: "Write a short, factual caption (max 12 words) for this image, for a personal journal. Return only the caption." },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      };
    })();
    const { text } = await this.run(prompt as any);
    return text.trim();
  }

  /** Apply a freeform edit instruction to an existing journal line's text. */
  async editText(current: string, instruction: string): Promise<string> {
    const prompt = `Current journal text:\n"""${fence(current)}"""\n\nEdit instruction: ${fence(instruction)}\n\nReturn ONLY the edited text, nothing else. Preserve voice and any [[wikilinks]] unless the edit changes them.`;
    const { text } = await this.run(prompt);
    return text.trim() || current;
  }

  /** Single-turn agent call; collects assistant text and token usage. */
  private async run(prompt: unknown, systemPrompt?: string): Promise<{ text: string; usage: { input: number; output: number } }> {
    let text = "";
    const usage = { input: 0, output: 0 };
    const stream = query({
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
        for (const b of msg.message?.content ?? []) if (b.type === "text") text += b.text;
        const u = msg.message?.usage;
        if (u) { usage.input += u.input_tokens ?? 0; usage.output += u.output_tokens ?? 0; }
      } else if (msg.type === "result" && typeof msg.result === "string" && !text) {
        text = msg.result;
      }
    }
    return { text, usage };
  }

  private extractJson(s: string): { text?: string; ambiguous?: Candidate[] } | null {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  }
}
