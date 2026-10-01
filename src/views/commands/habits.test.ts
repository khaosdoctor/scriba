import assert from "node:assert/strict";
import { test } from "node:test";
import { previousDate } from "../../lib/time.ts";
import { botHarness } from "../../test/bot-harness.ts";

test("/habits refuses a malformed date with the usage line and reads nothing", async () => {
  const h = await botHarness();
  const run = await h.say("/habits yesterday");
  assert.deepEqual(run.texts("sendMessage"), [
    "Usage: /habits or /habits YYYY-MM-DD",
  ]);
  assert.equal(run.rendered, "tg.sendMessage");
});

test("/habits with no argument reviews yesterday and says so when there is no note", async () => {
  const h = await botHarness();
  const run = await h.say("/habits");
  assert.deepEqual(run.texts("sendMessage"), [
    `No habits found for ${previousDate()}.`,
  ]);
});

test("/habits with a date sends one Begin card counting what is pending", async () => {
  const h = await botHarness();
  h.obsidian.readDailyNote = {
    path: "p.md",
    content: "## Habits\n- [ ] Practiced music\n- [ ] [Pages read:: 0]\n",
  };
  const run = await h.say("/habits 2026-07-05");
  assert.deepEqual(run.texts("sendMessage"), [
    `🌱 Time to review habits for 2026-07-05 — 2 to go.`,
  ]);
  assert.deepEqual(
    run.calls[0]?.payload.reply_markup.inline_keyboard
      .flat()
      .map((b: { callback_data: string }) => b.callback_data),
    ["hb:2026-07-05:begin"],
  );
});
