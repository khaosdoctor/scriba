import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness } from "../../test/bot-harness.ts";

const DAY = "2026-08-15";
const SKIP_JOURNAL = `fu:j:${DAY}`;

test("Skip drops the prompt and asks the next question", async () => {
  const h = await botHarness();
  const run = await h.tap(SKIP_JOURNAL);
  const dropped = run.calls.find((c) => c.method === "deleteMessage");
  assert.equal(dropped?.payload.message_id, 50);
  assert.match(run.texts("sendMessage")[0] ?? "", /Learned anything today\?/);
});

test("Skip on the last question just clears it", async () => {
  const h = await botHarness();
  const run = await h.tap(`fu:t:${DAY}`);
  assert.equal(run.calls.filter((c) => c.method === "deleteMessage").length, 1);
  assert.deepEqual(run.texts("sendMessage"), []);
});

test("a Skip tap with a bad code or date is rejected and changes nothing", async () => {
  for (const data of [`fu:x:${DAY}`, "fu:j:2026-99-99", "fu:j", `fu::${DAY}`]) {
    const h = await botHarness();
    const run = await h.tap(data);
    assert.equal(run.rendered, "ack(bad follow-up)", data);
  }
});

test("a prompt Telegram won't delete does not stop Skip from asking the next question", async () => {
  const h = await botHarness();
  h.failApi.add("deleteMessage");
  const run = await h.tap(SKIP_JOURNAL);
  assert.deepEqual(run.texts("answerCallbackQuery"), [undefined]);
  assert.match(run.texts("sendMessage")[0] ?? "", /Learned anything today\?/);
});

test("a second tap on the same prompt is ignored, but another prompt still works", async () => {
  const h = await botHarness();
  await h.tap(SKIP_JOURNAL);
  const again = await h.tap(SKIP_JOURNAL);
  assert.equal(again.rendered, "ack()");

  const other = await h.tap(SKIP_JOURNAL, { message: { message_id: 51 } });
  assert.equal(other.texts("sendMessage").length, 1);
});

test("two taps at once on one prompt ask the next question once", async () => {
  const h = await botHarness();
  const [a, b] = await Promise.all([h.tap(SKIP_JOURNAL), h.tap(SKIP_JOURNAL)]);
  const sends = new Set(
    [...a.calls, ...b.calls].filter((c) => c.method === "sendMessage"),
  );
  assert.equal(sends.size, 1);
});

test("a Skip tap whose message is gone is acknowledged and stops", async () => {
  const h = await botHarness();
  const run = await h.tap(SKIP_JOURNAL, { message: null });
  assert.equal(run.rendered, "ack()");
});

test("Skip on a stale prompt asks from the note as it is now", async () => {
  const filled = await botHarness();
  filled.obsidian.readDailyNote = {
    path: "p",
    content: "## Journal\n- a\n## TIL\n- b\n",
  };
  assert.deepEqual((await filled.tap(SKIP_JOURNAL)).texts("sendMessage"), []);

  const old = await botHarness();
  const run = await old.tap("fu:j:2026-06-25");
  assert.match(run.texts("sendMessage")[0] ?? "", /\(fu:t:2026-06-25\)/);
});
