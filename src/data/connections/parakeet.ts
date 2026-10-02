import { z } from "zod";
import { logger } from "../../libs/log.ts";

const log = logger("transcribe");

const ParakeetResponse = z.object({ text: z.string().optional() });

export class ParakeetTranscriber {
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
    // Local CPU inference on a long voice note takes a while; this only bounds a hang.
    const res = await fetch(this.url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`parakeet ${res.status}: ${await res.text()}`);
    const text = res.headers.get("content-type")?.includes("json")
      ? ParakeetResponse.parse(await res.json()).text
      : await res.text();
    const out = (text ?? "").trim();
    log.debug(
      { backend: "parakeet", chars: out.length },
      "transcription complete",
    );
    return out;
  }
}
