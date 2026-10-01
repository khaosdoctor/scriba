import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../../models/domain.ts";
import { botHarness } from "../../test/bot-harness.ts";

const FOLLOWUP =
  "One line for the day? Reply to this message, or skip.\n(fu:j:2026-07-05)";

test("a follow-up reply wins over an open task mode and is filed for the prompt's day", async () => {
  const h = await botHarness();
  const rows: Jot[] = [];
  h.repo.insertJot = (row: Jot) => void rows.push(row);
  await h.say("/task");
  const run = await h.say("Quiet day", { message_id: 7, text: FOLLOWUP });
  assert.equal(run.events.includes("repo.insertTaskDraft"), false);
  assert.equal(
    run.rendered,
    "tg.setMessageReaction > repo.insertJot > repo.mapMessage > obsidian.ensureDailyNote > obsidian.appendJournalLine > queue.add > tg.deleteMessage > obsidian.readDailyNote > tg.sendMessage",
  );
  assert.deepEqual(
    rows.map((r) => [r.note_path, r.time, r.raw_text]),
    [["notes/daily notes/2026-07-05.md", "23:59:59", "Quiet day"]],
  );
});
