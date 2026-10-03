import Groq, { toFile } from "groq-sdk";
import { logger } from "../../libs/log.ts";

const log = logger("transcribe");

/** Remote: Groq Whisper. Uses /translations, so any spoken language → English. */
export class GroqTranscriber {
  private groq: Groq;
  constructor(apiKey: string) {
    // Parakeet is the retry, so no SDK retries in front of it. The timeout covers the
    // upload plus Whisper on a long note, so it's the SDK's own 60s, said out loud.
    this.groq = new Groq({ apiKey, timeout: 60_000, maxRetries: 0 });
  }

  async transcribe(bytes: Uint8Array, ext: string): Promise<string> {
    // Groq validates by extension; Telegram voice is .oga, which isn't in its list.
    const groqExt = ext === "oga" ? "ogg" : ext;
    log.debug(
      { backend: "groq", ext, bytes: bytes.length },
      "transcribing (translations)",
    );
    const res = await this.groq.audio.translations.create({
      file: await toFile(bytes, `audio.${groqExt}`),
      model: "whisper-large-v3",
      response_format: "text",
    });
    const out = (
      typeof res === "string" ? res : (res as { text: string }).text
    ).trim();
    log.debug({ backend: "groq", chars: out.length }, "transcription complete");
    return out;
  }
}

/** OpenAI-shaped chat message (what the Groq SDK takes). Content is a string for
 *  text turns, or a content-part array for the vision (image) turn. */
export type GroqMessage = { role: "system" | "user"; content: unknown };

export const OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";

export type GroqChatFn = (
  apiKey: string,
  model: string,
  messages: GroqMessage[],
  baseUrl: string | undefined,
  timeoutMs: number,
) => Promise<{ text: string; usage: { input: number; output: number } }>;

export const groqChat: GroqChatFn = async (
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
    timeout: timeoutMs,
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
