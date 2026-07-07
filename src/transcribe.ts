import Groq from "groq-sdk";
import { writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "./log.ts";

const log = logger("transcribe");

/** Voice note bytes → English text. Two implementations, chosen by config. */
export interface Transcriber {
  transcribe(bytes: Uint8Array, ext: string): Promise<string>;
}

/** Remote: Groq Whisper. Uses /translations, so any spoken language → English. */
export class GroqTranscriber implements Transcriber {
  private groq: Groq;
  constructor(apiKey: string) {
    this.groq = new Groq({ apiKey });
  }

  async transcribe(bytes: Uint8Array, ext: string): Promise<string> {
    const path = join(tmpdir(), `scriba-${randomBytes(6).toString("hex")}.${ext}`);
    await writeFile(path, bytes);
    log.debug({ backend: "groq", ext, bytes: bytes.length }, "transcribing (translations)");
    try {
      const res = await this.groq.audio.translations.create({
        file: createReadStream(path),
        model: "whisper-large-v3",
        response_format: "text",
      });
      const out = (typeof res === "string" ? res : (res as { text: string }).text).trim();
      log.debug({ backend: "groq", chars: out.length }, "transcription complete");
      return out;
    } finally {
      await rm(path, { force: true });
    }
  }
}

/** Local: a Parakeet sidecar. Transcribes in the source language; the enricher
 *  translates to English downstream. */
export class ParakeetTranscriber implements Transcriber {
  constructor(private url: string) {}

  async transcribe(bytes: Uint8Array, ext: string): Promise<string> {
    // OpenAI-compatible ASR (e.g. ghcr.io/achetronic/parakeet): POST multipart `file`,
    // returns {text} (json) or the transcript (plain text) with response_format=text.
    const form = new FormData();
    form.append("file", new Blob([bytes]), `audio.${ext}`);
    form.append("response_format", "text");
    log.debug({ backend: "parakeet", url: this.url, ext, bytes: bytes.length }, "transcribing");
    const res = await fetch(this.url, { method: "POST", body: form });
    if (!res.ok) throw new Error(`parakeet ${res.status}: ${await res.text()}`);
    const text = res.headers.get("content-type")?.includes("json")
      ? (await res.json() as { text?: string }).text
      : await res.text();
    const out = String(text ?? "").trim();
    log.debug({ backend: "parakeet", chars: out.length }, "transcription complete");
    return out;
  }
}

export interface TranscriberConfig {
  mode: string;          // "local" | "remote" (validated in config)
  groqApiKey: string;
  parakeetUrl: string;
}

export function createTranscriber(cfg: TranscriberConfig): Transcriber {
  log.info({ mode: cfg.mode }, "transcriber selected");
  return cfg.mode === "local"
    ? new ParakeetTranscriber(cfg.parakeetUrl)
    : new GroqTranscriber(cfg.groqApiKey);
}
