import { logger } from "../libs/log.ts";

const log = logger("transcribe");

export interface Transcriber {
  transcribe(bytes: Uint8Array, ext: string): Promise<string>;
}

export class FallbackTranscriber implements Transcriber {
  constructor(private backends: { name: string; transcriber: Transcriber }[]) {
    log.info({ chain: this.chain }, "transcriber ready");
  }

  get chain(): string {
    return this.backends.map((backend) => backend.name).join(" → ");
  }

  async transcribe(bytes: Uint8Array, ext: string): Promise<string> {
    let lastErr: unknown = new Error("no transcriber configured");
    for (const { name, transcriber } of this.backends) {
      try {
        return await transcriber.transcribe(bytes, ext);
      } catch (err) {
        lastErr = err;
        log.warn({ err, backend: name }, "transcriber failed, trying next");
      }
    }
    throw lastErr;
  }
}
