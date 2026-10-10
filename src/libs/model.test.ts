import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CircuitBreaker,
  isRecoverable,
  parseModelJson,
  stripWrappingQuotes,
  switchNotice,
  unwrapModelPayload,
} from "./model.ts";

test("parseModelJson reads clean, fenced, prose-wrapped and line-broken JSON", () => {
  assert.deepEqual(parseModelJson('{"text":"a"}'), { text: "a" });
  assert.deepEqual(parseModelJson('```json\n{"text":"a"}\n```'), { text: "a" });
  assert.deepEqual(parseModelJson('Sure: {"text":"a"} ok'), { text: "a" });
  assert.deepEqual(parseModelJson('{"text": "a\n\nb\tc"}'), {
    text: "a\n\nb\tc",
  });
  assert.deepEqual(parseModelJson('{\n  "text": "a"\n}'), { text: "a" });
  assert.equal(parseModelJson("no json here"), null);
  assert.equal(parseModelJson("[1,2]"), null);
  assert.equal(parseModelJson('{"text": "unterminated'), null);
});

test("unwrapModelPayload unwraps a nested answer and keeps the inner lists", () => {
  const nested = {
    text: '{"text": "Also [[2026-09-29|Tuesday]] I have an interview", "ambiguous": [], "tasks": [{"description": "Go to the interview", "type": "personal"}]}',
    ambiguous: [],
    tasks: [],
  };
  const out = unwrapModelPayload(nested);
  assert.equal(out.text, "Also [[2026-09-29|Tuesday]] I have an interview");
  assert.deepEqual(out.tasks, [
    { description: "Go to the interview", type: "personal" },
  ]);
});

test("unwrapModelPayload keeps outer lists when they're already filled", () => {
  const out = unwrapModelPayload({
    text: '{"text": "hi", "ambiguous": [{"surface":"x","note":"y"}]}',
    ambiguous: [{ surface: "a", note: "b" }],
  });
  assert.equal(out.text, "hi");
  assert.deepEqual(out.ambiguous, [{ surface: "a", note: "b" }]);
});

test("unwrapModelPayload takes an inner til when the outer one is not true", () => {
  const nested = (til: unknown) =>
    unwrapModelPayload({ text: '{"text": "hi", "til": true}', til }).til;
  assert.equal(nested(false), true);
  assert.equal(nested(undefined), true);
  assert.equal(
    unwrapModelPayload({ text: '{"text":"hi","til":false}', til: true }).til,
    true,
  );
  assert.equal(
    unwrapModelPayload({ text: '{"text":"hi","til":"no"}', til: false }).til,
    "no",
  );
});

test("unwrapModelPayload keeps a missing til missing and an outer false false", () => {
  assert.equal(
    unwrapModelPayload({ text: '{"text":"hi"}', til: false }).til,
    false,
  );
  const none = unwrapModelPayload({ text: '{"text":"hi"}' });
  assert.equal(none.til, undefined);
  assert.ok("til" in none);
});

test("unwrapModelPayload keeps a til the model put in the inner answer", () => {
  const out = unwrapModelPayload({
    text: '{"text": "hi", "ambiguous": [], "til": true}',
    til: false,
  });
  assert.equal(out.til, true);
});

test("unwrapModelPayload unwraps several levels and strips an echoed fence", () => {
  const lvl2 = JSON.stringify({ text: '"""deep"""' });
  const lvl1 = JSON.stringify({ text: lvl2 });
  assert.equal(unwrapModelPayload({ text: lvl1 }).text, "deep");
});

test("unwrapModelPayload leaves ordinary text alone, braces included", () => {
  for (const text of [
    "Plain entry with [[Link]]",
    "{curly} is how I write sets",
    '{"not": "a payload"}',
    'She said """hi""" in the middle',
  ])
    assert.equal(unwrapModelPayload({ text }).text, text);
});

test("CircuitBreaker opens after the threshold, lets one trial through after the cooldown", () => {
  const clock = { now: 0 };
  const breaker = new CircuitBreaker(2, 100, () => clock.now);
  breaker.failure(new Error("a"));
  assert.equal(breaker.allows(), true);
  breaker.failure(new Error("b"));
  assert.equal(breaker.allows(), false);
  assert.equal((breaker.lastError as Error).message, "b");
  clock.now = 100;
  assert.equal(breaker.allows(), true);
  // the trial fails: straight back open, no second run-up to the threshold
  breaker.failure(new Error("c"));
  assert.equal(breaker.allows(), false);
  clock.now = 200;
  breaker.success();
  assert.equal(breaker.allows(), true);
  breaker.failure(new Error("d"));
  assert.equal(breaker.allows(), true);
});

test("isRecoverable flags transient infra errors, not terminal ones", () => {
  assert.equal(
    isRecoverable(new Error("connect ETIMEDOUT 10.0.0.1:443")),
    true,
  );
  assert.equal(
    isRecoverable(new Error("Request failed with status 503")),
    true,
  );
  assert.equal(isRecoverable(new Error("429 Too Many Requests")), true);
  assert.equal(isRecoverable(new Error("invalid path")), false);
});

test("switchNotice words each switch and quotes the reason where there is one", () => {
  assert.equal(
    switchNotice("fallback", "groq-model", new Error("usage exhausted")),
    "⚠️ Enrichment switched to fallback model groq-model. Quality may drop until the chosen model is back.\nReason: usage exhausted",
  );
  assert.equal(
    switchNotice("primary", "haiku"),
    "✅ Enrichment is back on haiku.",
  );
  assert.equal(
    switchNotice("down", "none", "overloaded"),
    "⏸ Every enrichment model is down, so new jots are held in place. They go into your journal on their own once one is back.\nReason: overloaded",
  );
});

test("isRecoverable covers the OpenAI-shaped SDKs' network errors", () => {
  assert.equal(isRecoverable(new Error("Connection error.")), true);
  assert.equal(isRecoverable(new Error("Request timed out.")), true);
  assert.equal(
    isRecoverable(new Error("timeout after 15s (claude-haiku-4-5)")),
    true,
  );
});

test("stripWrappingQuotes unwraps a jot quoted end to end", () => {
  assert.equal(
    stripWrappingQuotes('"Learned that [[Rust]] has no GC."'),
    "Learned that [[Rust]] has no GC.",
  );
  assert.equal(
    stripWrappingQuotes("  \u201CWent for a run.\u201D "),
    "Went for a run.",
  );
  assert.equal(stripWrappingQuotes("\u201EHej\u201C"), "Hej");
  assert.equal(stripWrappingQuotes("\u2018quiet day\u2019"), "quiet day");
  assert.equal(stripWrappingQuotes("\u00ABbonjour\u00BB"), "bonjour");
  assert.equal(stripWrappingQuotes('"""\n"layered"\n"""'), "layered");
});

test("stripWrappingQuotes leaves quotes that don't wrap the whole jot", () => {
  assert.equal(stripWrappingQuotes('"A" and "B"'), '"A" and "B"');
  assert.equal(stripWrappingQuotes('She said "hi"'), 'She said "hi"');
  assert.equal(
    stripWrappingQuotes("'Twas the students'"),
    "'Twas the students'",
  );
  assert.equal(stripWrappingQuotes('"'), '"');
  assert.equal(stripWrappingQuotes('"half'), '"half');
  assert.equal(stripWrappingQuotes(""), "");
});

test("unwrapModelPayload drops a plain quote pair around the text", () => {
  assert.equal(
    unwrapModelPayload({ text: '"TIL octopuses have three hearts"' }).text,
    "TIL octopuses have three hearts",
  );
});
