import Groq from "groq-sdk";
import { writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Transcribes voice notes via Groq Whisper. The vault is English but the author may
 *  speak another language (e.g. Portuguese), so this uses the /translations endpoint,
 *  which always outputs English regardless of the spoken language. No video. */
export class Transcriber {
  private groq: Groq;
  constructor(apiKey: string) {
    this.groq = new Groq({ apiKey });
  }

  async transcribe(bytes: Uint8Array, ext: string): Promise<string> {
    const path = join(tmpdir(), `scriba-${randomBytes(6).toString("hex")}.${ext}`);
    await writeFile(path, bytes);
    try {
      const res = await this.groq.audio.translations.create({
        file: createReadStream(path),
        model: "whisper-large-v3",
        response_format: "text",
      });
      return (typeof res === "string" ? res : (res as { text: string }).text).trim();
    } finally {
      await rm(path, { force: true });
    }
  }
}
