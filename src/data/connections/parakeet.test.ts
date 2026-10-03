import assert from "node:assert/strict";
import { test } from "node:test";
import { ParakeetTranscriber } from "./parakeet.ts";

function fakeResponse(body: string, json: boolean, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: () => (json ? "application/json" : "text/plain") },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

test("parakeet parses json {text} responses", async (testContext) => {
  testContext.mock.method(
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

test("parakeet rejects a json reply whose text is not a string", async (testContext) => {
  testContext.mock.method(
    globalThis,
    "fetch",
    async () => fakeResponse(JSON.stringify({ text: 42 }), true) as any,
  );
  await assert.rejects(
    new ParakeetTranscriber("http://p").transcribe(new Uint8Array([1]), "ogg"),
  );
});

test("parakeet returns an empty transcript for json without text", async (testContext) => {
  testContext.mock.method(
    globalThis,
    "fetch",
    async () => fakeResponse(JSON.stringify({}), true) as any,
  );
  const out = await new ParakeetTranscriber("http://p").transcribe(
    new Uint8Array([1]),
    "ogg",
  );
  assert.equal(out, "");
});

test("parakeet parses plain-text responses", async (testContext) => {
  testContext.mock.method(
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

test("parakeet throws on non-ok status", async (testContext) => {
  testContext.mock.method(
    globalThis,
    "fetch",
    async () => fakeResponse("boom", false, false) as any,
  );
  await assert.rejects(
    new ParakeetTranscriber("http://p").transcribe(new Uint8Array([1]), "ogg"),
    /parakeet 500/,
  );
});
