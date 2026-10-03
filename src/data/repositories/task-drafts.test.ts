import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleTaskDraft, withDb } from "../../test/sqlite.ts";
import { TaskDraftRepository } from "./task-drafts.ts";

test("task drafts: insert, update, claim once, and count per jot", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const drafts = new TaskDraftRepository(knex);
    await drafts.insertTaskDraft(
      sampleTaskDraft("d0000001", {
        source: "jot",
        jot_id: "aaaaaaaa",
        source_date: "2026-08-29",
        chat_id: 42,
        message_id: null,
      }),
    );
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
    await drafts.insertTaskDraft(
      sampleTaskDraft("d0000002", {
        description: "Buy milk",
        due: "2026-09-03",
        source_date: "2026-08-29",
        chat_id: 42,
        message_id: 7,
      }),
    );
    assert.equal(await drafts.claimTaskDraft("d0000002"), true);
    assert.equal(await drafts.claimTaskDraft("d0000002"), false); // already claimed
    assert.equal(await drafts.claimTaskDraft("d0000001"), false); // already created
    // A jot that has already been asked about is not asked about again on reprocess.
    assert.equal(await drafts.taskDraftsForJot("aaaaaaaa"), 1);
    assert.equal(await drafts.taskDraftsForJot("ffffffff"), 0);
    assert.equal(await drafts.getTaskDraft("nope"), undefined);
  });
});
