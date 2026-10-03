import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness } from "../../../test/bot-harness.ts";

const DAY = "2026-08-15";

test("a saved rating is confirmed, its buttons replaced, and the first follow-up question asked", async () => {
  const h = await botHarness();
  h.repo.recordRating = { recorded: true, current: 7 };
  const run = await h.tap(`rate:${DAY}:7`);
  assert.deepEqual(run.texts("answerCallbackQuery"), ["saved 7/10"]);
  assert.deepEqual(run.texts("editMessageText"), [`📊 ${DAY} rated 7/10`]);
  assert.match(run.texts("sendMessage")[0] ?? "", /One line for the day\?/);
});

test("a day that is already rated says so and is not asked about again", async () => {
  const h = await botHarness();
  h.repo.recordRating = { recorded: false, current: 8 };
  const run = await h.tap(`rate:${DAY}:3`);
  assert.deepEqual(run.texts("answerCallbackQuery"), ["already rated 8/10"]);
  assert.deepEqual(run.texts("editMessageText"), [
    `📊 ${DAY} already rated 8/10.`,
  ]);
  assert.deepEqual(run.texts("sendMessage"), []);
});

test("a follow-up that fails to start does not undo or fail the rating", async () => {
  const h = await botHarness();
  h.repo.recordRating = { recorded: true, current: 7 };
  h.obsidian.readDailyNote = () => {
    throw new Error("vault 500");
  };
  const run = await h.tap(`rate:${DAY}:7`);
  assert.deepEqual(run.texts("answerCallbackQuery"), ["saved 7/10"]);
  assert.deepEqual(run.texts("editMessageText"), [`📊 ${DAY} rated 7/10`]);
});

test("a bad payload is refused before anything is recorded", async () => {
  for (const data of [
    "rate:",
    `rate:${DAY}`,
    "rate:not-a-date:7",
    "rate:2026-02-31:7",
    `rate:${DAY}:0`,
    `rate:${DAY}:11`,
    `rate:${DAY}:x`,
  ]) {
    const h = await botHarness();
    const run = await h.tap(data);
    assert.equal(run.rendered, "ack(bad rating)", data);
  }
});
