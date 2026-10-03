import assert from "node:assert/strict";
import { test } from "node:test";
import { previousDate } from "../../../libs/time.ts";
import { botHarness } from "../../../test/bot-harness.ts";

test("/habits refuses a malformed date with the usage line and reads nothing", async () => {
  const harness = await botHarness();
  const run = await harness.say("/habits yesterday");
  assert.deepEqual(run.texts("sendMessage"), [
    "Usage: /habits or /habits YYYY-MM-DD",
  ]);
  assert.equal(run.rendered, "tg.sendMessage");
});

test("/habits refuses an impossible date with the same usage line", async () => {
  const harness = await botHarness();
  const run = await harness.say("/habits 2026-02-31");
  assert.deepEqual(run.texts("sendMessage"), [
    "Usage: /habits or /habits YYYY-MM-DD",
  ]);
  assert.equal(run.rendered, "tg.sendMessage");
});

test("/habits with no argument reviews yesterday and says so when there is no note", async () => {
  const harness = await botHarness();
  const run = await harness.say("/habits");
  assert.deepEqual(run.texts("sendMessage"), [
    `No habits found for ${previousDate()}.`,
  ]);
});

test("/habits with a date sends one Begin card counting what is pending", async () => {
  const harness = await botHarness();
  harness.obsidian.readDailyNote = {
    path: "p.md",
    content: "## Habits\n- [ ] Practiced music\n- [ ] [Pages read:: 0]\n",
  };
  const run = await harness.say("/habits 2026-07-05");
  assert.deepEqual(run.texts("sendMessage"), [
    `🌱 Time to review habits for 2026-07-05 — 2 to go.`,
  ]);
  assert.deepEqual(
    run.calls[0]?.payload.reply_markup.inline_keyboard
      .flat()
      .map((button: { callback_data: string }) => button.callback_data),
    ["hb:2026-07-05:begin"],
  );
});
