import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

const BASE: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "t",
  ALLOWED_TELEGRAM_USER_ID: "1",
  OBSIDIAN_API_KEY: "o",
};

const load = (env: Record<string, string> = {}) =>
  loadConfig({ ...BASE, ...env });

test("groq key is optional and the sidecar url has a default", () => {
  const config = load();
  assert.equal(config.transcription.groqApiKey, "");
  assert.match(config.transcription.parakeetUrl, /parakeet:5092/);
  assert.equal(config.enrich.backupModel, "claude-sonnet-5-5");
});

test("a variable the schema doesn't know, such as a retired key, is ignored", () => {
  assert.doesNotThrow(() =>
    load({ RETIRED_API_KEY: "left over in the deploy" }),
  );
});

test("groq key and an explicit PARAKEET_URL are passed through", () => {
  const config = load({
    GROQ_API_KEY: "gk",
    PARAKEET_URL: "http://custom/asr",
  });
  assert.equal(config.transcription.groqApiKey, "gk");
  assert.equal(config.transcription.parakeetUrl, "http://custom/asr");
});

test("a blank PARAKEET_URL fails at boot", () => {
  assert.throws(() => load({ PARAKEET_URL: "" }), /Invalid configuration/);
});

test("a missing required variable fails at boot and the message names it", () => {
  assert.throws(
    () => loadConfig({ ALLOWED_TELEGRAM_USER_ID: "1", OBSIDIAN_API_KEY: "o" }),
    /Invalid configuration[\s\S]*TELEGRAM_BOT_TOKEN/,
  );
});

test("OBSIDIAN_INSECURE_TLS defaults off and parses to boolean", () => {
  assert.equal(load().obsidian.insecureTls, false);
  assert.equal(
    load({ OBSIDIAN_INSECURE_TLS: "true" }).obsidian.insecureTls,
    true,
  );
});

test("the TIL heading defaults to TIL", () => {
  assert.equal(load().obsidian.tilHeading, "TIL");
});

test("TIL_HEADING is trimmed, tabs and newlines included", () => {
  for (const raw of ["  TIL  ", "TIL\t", "TIL\n", "\tTIL\r\n"]) {
    const config = load({ TIL_HEADING: raw });
    assert.equal(config.obsidian.tilHeading, "TIL", JSON.stringify(raw));
  }
});

test("a blank TIL_HEADING fails at boot", () => {
  for (const raw of ["", "   ", "\t\n"])
    assert.throws(
      () => load({ TIL_HEADING: raw }),
      /Invalid configuration/,
      JSON.stringify(raw),
    );
});

test("task note paths drop the backslash Coolify puts before a quote", () => {
  const config = load({
    TASKS_WORK_NOTE: "notes/tracking notes/What\\'s going on at work.md",
    TASKS_PERSONAL_NOTE: 'notes/the \\"later\\" list.md',
  });
  assert.equal(
    config.tasks.work.path,
    "notes/tracking notes/What's going on at work.md",
  );
  assert.equal(config.tasks.personal.path, 'notes/the "later" list.md');
});

test("TIL_HEADING is configurable without touching the other headings", () => {
  const config = load({ TIL_HEADING: "Today I learned" });
  assert.equal(config.obsidian.tilHeading, "Today I learned");
  assert.equal(config.obsidian.journalHeading, "Journal");
  assert.equal(config.obsidian.habitsHeading, "Habits");
});
