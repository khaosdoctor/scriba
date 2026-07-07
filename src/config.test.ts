import { test } from "node:test";
import assert from "node:assert/strict";

const BASE: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "t",
  ALLOWED_TELEGRAM_USER_ID: "1",
  OBSIDIAN_API_KEY: "o",
};

let counter = 0;
/** Load config.ts fresh with a given env (config reads process.env at import time). */
async function load(env: Record<string, string>) {
  const saved = { ...process.env };
  // wipe the vars we care about so leakage between cases can't hide a bug
  for (const k of ["GROQ_API_KEY", "PARAKEET_URL", "TRANSCRIBER"]) delete process.env[k];
  Object.assign(process.env, BASE, env);
  try {
    return await import(`./config.ts?v=${counter++}`);
  } finally {
    process.env = saved;
  }
}

test("remote mode requires GROQ_API_KEY", async () => {
  await assert.rejects(load({ TRANSCRIBER: "remote" }), /GROQ_API_KEY/);
});

test("remote mode wires groq, leaves parakeet empty", async () => {
  const { config } = await load({ TRANSCRIBER: "remote", GROQ_API_KEY: "gk" });
  assert.equal(config.transcription.mode, "remote");
  assert.equal(config.transcription.groqApiKey, "gk");
  assert.equal(config.transcription.parakeetUrl, "");
});

test("local mode needs no groq and defaults the sidecar url", async () => {
  const { config } = await load({ TRANSCRIBER: "local" });
  assert.equal(config.transcription.mode, "local");
  assert.equal(config.transcription.groqApiKey, "");
  assert.match(config.transcription.parakeetUrl, /parakeet:5092/);
});

test("local mode respects an explicit PARAKEET_URL", async () => {
  const { config } = await load({ TRANSCRIBER: "local", PARAKEET_URL: "http://custom/asr" });
  assert.equal(config.transcription.parakeetUrl, "http://custom/asr");
});

test("default mode is local (needs no groq, defaults the sidecar url)", async () => {
  const { config } = await load({});
  assert.equal(config.transcription.mode, "local");
  assert.equal(config.transcription.groqApiKey, "");
  assert.match(config.transcription.parakeetUrl, /parakeet:5092/);
});

test("invalid TRANSCRIBER throws", async () => {
  await assert.rejects(load({ TRANSCRIBER: "cloud", GROQ_API_KEY: "gk" }), /must be "local" or "remote"/);
});
