import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTranscriber,
  FallbackTranscriber,
  ParakeetTranscriber,
} from "./transcribe.ts";

const ok = (text: string) => ({ transcribe: async () => text });
const down = (msg: string) => ({
  transcribe: async (): Promise<string> => {
    throw new Error(msg);
  },
});

test("groq goes first when a key is set; parakeet is always last", () => {
  assert.equal(
    buildTranscriber({ groqApiKey: "k", parakeetUrl: "http://p" }).chain,
    "groq → parakeet",
  );
  assert.equal(
    buildTranscriber({ groqApiKey: "", parakeetUrl: "http://p" }).chain,
    "parakeet",
  );
});

test("falls through to the next backend when one fails", async () => {
  const t = new FallbackTranscriber([
    { name: "groq", t: down("groq down") },
    { name: "parakeet", t: ok("local text") },
  ]);
  assert.equal(await t.transcribe(new Uint8Array([1]), "ogg"), "local text");
});

test("uses the first backend that answers and never calls the rest", async () => {
  const t = new FallbackTranscriber([
    { name: "groq", t: ok("remote text") },
    { name: "parakeet", t: down("should not run") },
  ]);
  assert.equal(await t.transcribe(new Uint8Array([1]), "ogg"), "remote text");
});

test("throws the last error when every backend fails", async () => {
  const t = new FallbackTranscriber([
    { name: "groq", t: down("groq down") },
    { name: "parakeet", t: down("parakeet down") },
  ]);
  await assert.rejects(
    t.transcribe(new Uint8Array([1]), "ogg"),
    /parakeet down/,
  );
});

function fakeResponse(body: string, json: boolean, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: () => (json ? "application/json" : "text/plain") },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

test("parakeet parses json {text} responses", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => fakeResponse(JSON.stringify({ text: " hi " }), true) as any,
  );
  const out = await new ParakeetTranscriber("http://p").transcribe(
    new Uint8Array([1]),
    "ogg",
  );
  assert.equal(out, "hi");
});

test("parakeet parses plain-text responses", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => fakeResponse("yo\n", false) as any,
  );
  const out = await new ParakeetTranscriber("http://p").transcribe(
    new Uint8Array([1]),
    "ogg",
  );
  assert.equal(out, "yo");
});

test("parakeet throws on non-ok status", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => fakeResponse("boom", false, false) as any,
  );
  await assert.rejects(
    new ParakeetTranscriber("http://p").transcribe(new Uint8Array([1]), "ogg"),
    /parakeet 500/,
  );
});
