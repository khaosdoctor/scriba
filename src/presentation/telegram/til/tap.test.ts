import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness, JOT_ID, sampleJot } from "../../../test/bot-harness.ts";

async function setup(moved: "moved" | "no-line" | "no-heading" = "moved") {
  const h = await botHarness();
  h.repo.getJot = sampleJot();
  h.obsidian.moveToTil = moved;
  h.repo.groupFollowers = [];
  return h;
}

test("each outcome gets its toast and a final card text with the buttons cleared", async () => {
  const cases = [
    ["moved", `ti:y:${JOT_ID}`, "moved to TIL", "💡 Moved to TIL."],
    [
      "no-line",
      `ti:y:${JOT_ID}`,
      "couldn't find the line",
      "⚠️ That line is gone from the note.",
    ],
    [
      "no-heading",
      `ti:y:${JOT_ID}`,
      "no TIL heading",
      "⚠️ That note has no TIL heading, so the line stays in the journal.",
    ],
    [
      "moved",
      `ti:n:${JOT_ID}`,
      "kept in the journal",
      "🚫 Kept in the journal.",
    ],
  ] as const;
  for (const [moved, data, toast, card] of cases) {
    const h = await setup(moved);
    const run = await h.tap(data);
    const edit = run.calls.find((c) => c.method === "editMessageText");
    assert.deepEqual(
      run.calls.find((c) => c.method === "answerCallbackQuery")?.payload.text,
      toast,
    );
    assert.equal(edit?.payload.text, card);
    assert.deepEqual(edit?.payload.reply_markup.inline_keyboard.flat(), []);
  }
});

test("a failed move alerts and leaves the card's buttons for a retry", async () => {
  const h = await setup();
  h.obsidian.moveToTil = () => {
    throw new Error("obsidian is down");
  };
  const run = await h.tap(`ti:y:${JOT_ID}`);
  const ack = run.calls.find((c) => c.method === "answerCallbackQuery");
  assert.equal(ack?.payload.text, "couldn't move it, tap again to retry");
  assert.equal(ack?.payload.show_alert, true);
  assert.equal(run.texts("editMessageText").length, 0);
});

test("a jot that is gone answers gone and settles the card", async () => {
  const h = await botHarness();
  const run = await h.tap(`ti:y:${JOT_ID}`);
  assert.deepEqual(run.texts("editMessageText"), ["That jot is gone."]);
});

test("a card Telegram refuses to edit does not undo the move", async () => {
  const h = await setup();
  h.failApi.add("editMessageText");
  const run = await h.tap(`ti:y:${JOT_ID}`);
  assert.match(run.rendered, /repo\.updateJot/);
  assert.equal(run.texts("answerCallbackQuery").length, 1);
});

test("an expired tap rejects after the move and the card is not settled", async () => {
  for (const data of [`ti:y:${JOT_ID}`, `ti:n:${JOT_ID}`]) {
    const h = await setup();
    h.failApi.add("answerCallbackQuery");
    const run = await h.tap(data);
    assert.equal(run.texts("editMessageText").length, 0);
  }
});
