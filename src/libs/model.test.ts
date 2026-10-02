import assert from "node:assert/strict";
import { test } from "node:test";
import { CircuitBreaker, parseModelJson, unwrapModelPayload } from "./model.ts";

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
  const t = { now: 0 };
  const b = new CircuitBreaker(2, 100, () => t.now);
  b.failure(new Error("a"));
  assert.equal(b.allows(), true);
  b.failure(new Error("b"));
  assert.equal(b.allows(), false);
  assert.equal((b.lastError as Error).message, "b");
  t.now = 100;
  assert.equal(b.allows(), true);
  // the trial fails: straight back open, no second run-up to the threshold
  b.failure(new Error("c"));
  assert.equal(b.allows(), false);
  t.now = 200;
  b.success();
  assert.equal(b.allows(), true);
  b.failure(new Error("d"));
  assert.equal(b.allows(), true);
});
