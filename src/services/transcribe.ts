import Groq, { toFile } from "groq-sdk";
import { logger } from "../log.ts";

const log = logger("transcribe");

/** Voice note bytes → text. Groq first, the Parakeet sidecar when Groq fails. */
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
		log.debug(
			{ backend: "parakeet", url: this.url, ext, bytes: bytes.length },
			"transcribing",
		);
		const res = await fetch(this.url, { method: "POST", body: form });
		if (!res.ok) throw new Error(`parakeet ${res.status}: ${await res.text()}`);
		const text = res.headers.get("content-type")?.includes("json")
			? ((await res.json()) as { text?: string }).text
			: await res.text();
		const out = String(text ?? "").trim();
		log.debug(
			{ backend: "parakeet", chars: out.length },
			"transcription complete",
		);
		return out;
	}
}

/** Tries each backend in order, moving on when one throws. Remote first (Groq also
 *  translates to English), then the always-on local Parakeet sidecar. */
export class FallbackTranscriber implements Transcriber {
	constructor(private backends: { name: string; t: Transcriber }[]) {}

	/** Backend order for /status, e.g. "groq → parakeet". */
	get chain(): string {
		return this.backends.map((b) => b.name).join(" → ");
	}

	async transcribe(bytes: Uint8Array, ext: string): Promise<string> {
		let lastErr: unknown = new Error("no transcriber configured");
		for (const { name, t } of this.backends) {
			try {
				return await t.transcribe(bytes, ext);
			} catch (err) {
				lastErr = err;
				log.warn({ err, backend: name }, "transcriber failed, trying next");
			}
		}
		throw lastErr;
	}
}

/** Groq when a key is set, then Parakeet. */
export function buildTranscriber(cfg: {
	groqApiKey: string;
	parakeetUrl: string;
}): FallbackTranscriber {
	const backends = [];
	if (cfg.groqApiKey)
		backends.push({ name: "groq", t: new GroqTranscriber(cfg.groqApiKey) });
	backends.push({
		name: "parakeet",
		t: new ParakeetTranscriber(cfg.parakeetUrl),
	});
	const out = new FallbackTranscriber(backends);
	log.info({ chain: out.chain }, "transcriber ready");
	return out;
}
