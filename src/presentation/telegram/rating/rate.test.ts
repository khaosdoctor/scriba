import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness } from "../../../test/bot-harness.ts";

test("/rate refuses an impossible date with the same usage line", async () => {
  const harness = await botHarness();
  const run = await harness.say("/rate 2026-02-31");
  assert.deepEqual(run.texts("sendMessage"), [
    "Usage: /rate or /rate YYYY-MM-DD",
  ]);
});

test("/rate prompts for the day given, and refuses a malformed date with the usage line", async () => {
  const harness = await botHarness();

  const bad = await harness.say("/rate tomorrow");
  assert.deepEqual(bad.texts("sendMessage"), [
    "Usage: /rate or /rate YYYY-MM-DD",
  ]);

  const day = await harness.say("/rate 2026-07-05");
  assert.deepEqual(day.texts("sendMessage"), [
    "📊 How was 2026-07-05? Rate it 1–10:",
  ]);
  const rows: { callback_data: string }[][] =
    day.calls[0]?.payload.reply_markup.inline_keyboard;
  assert.deepEqual(
    rows.map((row) => row.map((button) => button.callback_data)),
    [
      [1, 2, 3, 4, 5].map((score) => `rate:2026-07-05:${score}`),
      [6, 7, 8, 9, 10].map((score) => `rate:2026-07-05:${score}`),
    ],
  );

  const today = await harness.say("/rate");
  assert.match(
    today.texts("sendMessage")[0] ?? "",
    /^📊 How was \d{4}-\d{2}-\d{2}\?/,
  );
});
