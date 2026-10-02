import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskDraftRow } from "../../domain/task/entity.ts";
import { botHarness, NOW } from "../../test/bot-harness.ts";

const draft = (over: Partial<TaskDraftRow> = {}): TaskDraftRow => ({
  id: "d1d1d1d1",
  source: "mode",
  jot_id: null,
  type: "personal",
  description: "Buy cat sand",
  start: null,
  due: "2026-09-02",
  source_date: "2026-08-16",
  status: "pending",
  chat_id: 1,
  message_id: 50,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

const NOTE = [
  "## Things to do",
  "- [ ] Buy cat sand #type/todo [due:: 2099-01-01]",
].join("\n");

const open = async () => {
  const h = await botHarness();
  h.obsidian.readNote = NOTE;
  return h;
};

test("a list button redraws the tapped message with that screen, and an unknown screen falls back to the open list", async () => {
  const h = await open();
  assert.match(
    (await h.tap("tk:v:overdue:0")).texts("editMessageText")[0] ?? "",
    /⏰ Overdue[\s\S]*Nothing here\./,
  );
  assert.match(
    (await h.tap("tk:v:bogus:0")).texts("editMessageText")[0] ?? "",
    /📋 All open tasks/,
  );
});

test("the Tasks button goes back to the menu with both detection switches", async () => {
  const run = await (await open()).tap("tk:m");
  const edit = run.calls.find((c) => c.method === "editMessageText");
  assert.match(edit?.payload.text, /🗂 Tasks/);
  assert.deepEqual(
    edit?.payload.reply_markup.inline_keyboard
      .flat()
      .map((b: { callback_data: string }) => b.callback_data)
      .slice(-3),
    ["tk:det", "tk:til", "tk:close"],
  );
});

test("a question asked because of a tap is a force_reply, so the answer goes to the prompt", async () => {
  for (const [tap, over] of [
    ["tk:u:d1d1d1d1", {}],
    ["tk:ok:d1d1d1d1", { due: null }],
  ] as const) {
    const h = await open();
    h.repo.getTaskDraft = draft(over);
    const run = await h.tap(tap);
    const sent = run.calls.find((c) => c.method === "sendMessage");
    assert.equal(sent?.payload.reply_markup?.force_reply, true, tap);
  }
});

test("a tick redraws the list it came from, on the page it was drawn on", async () => {
  const h = await open();
  const [row] = (await h.tap("tk:v:open:0")).calls
    .find((c) => c.method === "editMessageText")!
    .payload.reply_markup.inline_keyboard.flat();
  const run = await h.tap(row.callback_data);
  assert.match(run.texts("editMessageText")[0] ?? "", /📋 All open tasks/);
});
