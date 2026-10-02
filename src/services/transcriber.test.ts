import assert from "node:assert/strict";
import { test } from "node:test";
import { FallbackTranscriber } from "./transcriber.ts";

const ok = (text: string) => ({ transcribe: async () => text });
const down = (msg: string) => ({
  transcribe: async (): Promise<string> => {
    throw new Error(msg);
  },
});

test("falls through to the next backend when one fails", async () => {
  const fallback = new FallbackTranscriber([
    { name: "groq", transcriber: down("groq down") },
    { name: "parakeet", transcriber: ok("local text") },
  ]);
  assert.equal(
    await fallback.transcribe(new Uint8Array([1]), "ogg"),
    "local text",
  );
});

test("uses the first backend that answers and never calls the rest", async () => {
  const fallback = new FallbackTranscriber([
    { name: "groq", transcriber: ok("remote text") },
    { name: "parakeet", transcriber: down("should not run") },
  ]);
  assert.equal(
    await fallback.transcribe(new Uint8Array([1]), "ogg"),
    "remote text",
  );
});

test("throws the last error when every backend fails", async () => {
  const fallback = new FallbackTranscriber([
    { name: "groq", transcriber: down("groq down") },
    { name: "parakeet", transcriber: down("parakeet down") },
  ]);
  await assert.rejects(
    fallback.transcribe(new Uint8Array([1]), "ogg"),
    /parakeet down/,
  );
});
