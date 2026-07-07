import Groq, { toFile } from "groq-sdk";
import { logger } from "../log.ts";

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

export interface TranscriberConfig {
	mode: string; // "local" | "remote" (validated in config)
	groqApiKey: string;
	parakeetUrl: string;
}

export type TranscriberMode = "local" | "remote";

function build(mode: TranscriberMode, cfg: TranscriberConfig): Transcriber {
	if (mode === "local") {
		if (!cfg.parakeetUrl) throw new Error("no PARAKEET_URL configured");
		return new ParakeetTranscriber(cfg.parakeetUrl);
	}
	if (!cfg.groqApiKey)
		throw new Error("GROQ_API_KEY not set — remote transcription unavailable");
	return new GroqTranscriber(cfg.groqApiKey);
}

export function createTranscriber(cfg: TranscriberConfig): Transcriber {
	log.info({ mode: cfg.mode }, "transcriber selected");
	return build(cfg.mode as TranscriberMode, cfg);
}

/** A Transcriber whose backend can be swapped at runtime by /transcriber. Delegates
 *  every call to the current backend; setMode rebuilds it (and throws, leaving the old
 *  one in place, if the target backend's creds are missing). */
export class TranscriberSwitch implements Transcriber {
	private current: Transcriber;
	private modeVal: TranscriberMode;

	constructor(
		private cfg: TranscriberConfig,
		mode: TranscriberMode = cfg.mode as TranscriberMode,
	) {
		this.modeVal = mode;
		this.current = build(mode, cfg);
		log.info({ mode }, "transcriber switch initialised");
	}

	get mode(): TranscriberMode {
		return this.modeVal;
	}

	/** Swap backend. Throws (mode unchanged) if the target's creds aren't configured. */
	setMode(mode: TranscriberMode): void {
		if (mode === this.modeVal) return;
		this.current = build(mode, this.cfg); // throws before we mutate modeVal
		this.modeVal = mode;
		log.info({ mode }, "transcriber switched");
	}

	transcribe(bytes: Uint8Array, ext: string): Promise<string> {
		return this.current.transcribe(bytes, ext);
	}
}
