import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskDraftRepository } from "../repositories/task-drafts.ts";
import { withDb } from "../test/sqlite.ts";

test("task drafts: insert, update, claim once, and count per jot", async (t) => {
  await withDb(t, async (k) => {
    const drafts = new TaskDraftRepository(k);
    await drafts.insertTaskDraft({
      id: "d0000001",
      source: "jot",
      jot_id: "aaaaaaaa",
      type: "personal",
      description: "Buy cat sand",
      start: null,
      due: "2026-09-02",
      source_date: "2026-08-29",
      status: "pending",
      chat_id: 42,
      message_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    assert.equal(
      (await drafts.getTaskDraft("d0000001"))?.description,
      "Buy cat sand",
    );
    await drafts.updateTaskDraft("d0000001", {
      type: "work",
      status: "created",
    });
    const draft = await drafts.getTaskDraft("d0000001");
    assert.equal(draft?.type, "work");
    assert.equal(draft?.status, "created");
    // Only one caller may turn a draft into a task, however fast the button is tapped.
    await drafts.insertTaskDraft({
      id: "d0000002",
      source: "mode",
      jot_id: null,
      type: "personal",
      description: "Buy milk",
      start: null,
      due: "2026-09-03",
      source_date: "2026-08-29",
      status: "pending",
      chat_id: 42,
      message_id: 7,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    assert.equal(await drafts.claimTaskDraft("d0000002"), true);
    assert.equal(await drafts.claimTaskDraft("d0000002"), false); // already claimed
    assert.equal(await drafts.claimTaskDraft("d0000001"), false); // already created
    // A jot that has already been asked about is not asked about again on reprocess.
    assert.equal(await drafts.taskDraftsForJot("aaaaaaaa"), 1);
    assert.equal(await drafts.taskDraftsForJot("ffffffff"), 0);
    assert.equal(await drafts.getTaskDraft("nope"), undefined);
  });
});
