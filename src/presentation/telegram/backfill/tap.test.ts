import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness, JOT_ID, sampleJot } from "../../../test/bot-harness.ts";

async function setup(moved: "moved" | "no-line" = "moved") {
  const harness = await botHarness();
  harness.repo.getJot = sampleJot();
  harness.repo.groupFollowers = [];
  harness.obsidian.moveToDay = moved;
  return harness;
}

const toast = (run: { calls: { method: string; payload: any }[] }) =>
  run.calls.find((call) => call.method === "answerCallbackQuery")?.payload;

test("a day tap moves the jot and leaves an Undo on the card", async () => {
  const harness = await setup();
  const run = await harness.tap(`bf:m:${JOT_ID}:2026-08-10`);
  assert.match(run.rendered, /obsidian\.moveToDay/);
  assert.equal(toast(run).text, "moved");
  const edit = run.calls.find((call) => call.method === "editMessageText");
  assert.equal(edit?.payload.text, "🗓 Moved to Mon 2026-08-10.");
  assert.deepEqual(
    edit?.payload.reply_markup.inline_keyboard
      .flat()
      .map((button: any) => button.callback_data),
    [`ed:${JOT_ID}`, `bf:u:${JOT_ID}`],
  );
});

test("Undo moves it back and clears the card", async () => {
  const harness = await setup();
  harness.repo.getJot = sampleJot({
    note_path: "notes/daily notes/2026-08-10.md",
  });
  const run = await harness.tap(`bf:u:${JOT_ID}`);
  assert.match(run.rendered, /obsidian\.moveToDay/);
  assert.deepEqual(run.texts("editMessageText"), [
    "↩️ Moved back to the day you wrote it.",
  ]);
});

test("Keep settles the card without touching the vault", async () => {
  const harness = await setup();
  const run = await harness.tap(`bf:k:${JOT_ID}`);
  assert.doesNotMatch(run.rendered, /moveToDay/);
  assert.deepEqual(run.texts("editMessageText"), ["🚫 Kept where it was."]);
});

test("Other day redraws the buttons as that month's calendar", async () => {
  const harness = await setup();
  const run = await harness.tap(`bf:c:${JOT_ID}:2026-08`);
  const redraw = run.calls.find(
    (call) => call.method === "editMessageReplyMarkup",
  );
  assert.equal(
    redraw?.payload.reply_markup.inline_keyboard[0][1].text,
    "August 2026",
  );
});

test("a future day, a bad payload or a filler cell moves nothing", async () => {
  for (const data of [
    `bf:m:${JOT_ID}:2999-01-01`,
    `bf:m:${JOT_ID}:nope`,
    `bf:c:${JOT_ID}:13-99`,
    "bf:x",
  ]) {
    const run = await (await setup()).tap(data);
    assert.doesNotMatch(run.rendered, /moveToDay/);
    assert.equal(toast(run).text, "bad button");
  }
  const filler = await (await setup()).tap("bf:n");
  assert.equal(filler.calls.length, 1);
});

test("a missing line or a gone jot settles the card; a busy jot only alerts", async () => {
  const lost = await (await setup("no-line")).tap(`bf:m:${JOT_ID}:2026-08-10`);
  assert.deepEqual(lost.texts("editMessageText"), [
    "⚠️ That line is gone from the note.",
  ]);
  const gone = await (await botHarness()).tap(`bf:m:${JOT_ID}:2026-08-10`);
  assert.deepEqual(gone.texts("editMessageText"), ["That jot is gone."]);
  const harness = await setup();
  harness.repo.getJot = sampleJot({ status: "processing" });
  const busy = await harness.tap(`bf:m:${JOT_ID}:2026-08-10`);
  assert.equal(toast(busy).show_alert, true);
  assert.deepEqual(busy.texts("editMessageText"), []);
});
