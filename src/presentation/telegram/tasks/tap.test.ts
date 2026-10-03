import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness, sampleDraft } from "../../../test/bot-harness.ts";

const NOTE = [
  "## Things to do",
  "- [ ] Buy cat sand #type/todo [due:: 2099-01-01]",
].join("\n");

const open = async () => {
  const harness = await botHarness();
  harness.obsidian.readNote = NOTE;
  return harness;
};

test("a list button redraws the tapped message with that screen, and an unknown screen falls back to the open list", async () => {
  const harness = await open();
  assert.match(
    (await harness.tap("tk:v:overdue:0")).texts("editMessageText")[0] ?? "",
    /⏰ Overdue[\s\S]*Nothing here\./,
  );
  assert.match(
    (await harness.tap("tk:v:bogus:0")).texts("editMessageText")[0] ?? "",
    /📋 All open tasks/,
  );
});

test("the Tasks button goes back to the menu with both detection switches", async () => {
  const run = await (await open()).tap("tk:m");
  const edit = run.calls.find((call) => call.method === "editMessageText");
  assert.match(edit?.payload.text, /🗂 Tasks/);
  assert.deepEqual(
    edit?.payload.reply_markup.inline_keyboard
      .flat()
      .map((button: { callback_data: string }) => button.callback_data)
      .slice(-3),
    ["tk:det", "tk:til", "tk:close"],
  );
});

test("a question asked because of a tap is a force_reply, so the answer goes to the prompt", async () => {
  for (const [tap, over] of [
    ["tk:u:d1d1d1d1", {}],
    ["tk:ok:d1d1d1d1", { due: null }],
  ] as const) {
    const harness = await open();
    harness.repo.getTaskDraft = sampleDraft(over);
    const run = await harness.tap(tap);
    const sent = run.calls.find((call) => call.method === "sendMessage");
    assert.equal(sent?.payload.reply_markup?.force_reply, true, tap);
  }
});

test("a tick redraws the list it came from, on the page it was drawn on", async () => {
  const harness = await open();
  const [row] = (await harness.tap("tk:v:open:0")).calls
    .find((call) => call.method === "editMessageText")!
    .payload.reply_markup.inline_keyboard.flat();
  const run = await harness.tap(row.callback_data);
  assert.match(run.texts("editMessageText")[0] ?? "", /📋 All open tasks/);
});
