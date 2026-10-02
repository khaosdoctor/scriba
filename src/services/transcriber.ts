import { GroqTranscriber } from "../data/connections/groq.ts";
import { ParakeetTranscriber } from "../data/connections/parakeet.ts";
import { logger } from "../libs/log.ts";

const log = logger("transcribe");

/** Voice note bytes → text. Groq first, the Parakeet sidecar when Groq fails. */
export interface Transcriber {
  transcribe(bytes: Uint8Array, ext: string): Promise<string>;
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
