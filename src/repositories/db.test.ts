import assert from "node:assert/strict";
import { test } from "node:test";
import { Repository } from "../db.ts";
import { sampleJot, withDb } from "../test/sqlite.ts";
import { JotRepository } from "./jots.ts";
import { LinkRuleRepository } from "./link-rules.ts";
import { RatingRepository } from "./ratings.ts";
import { SettingsRepository } from "./settings.ts";
import { TaskDraftRepository } from "./task-drafts.ts";

test("a jot's life through the Repository facade reaches the right table at every step", async (t) => {
  let repo: Repository;
  try {
    repo = await Repository.open(":memory:");
  } catch (e) {
    return t.skip(
      `native sqlite unavailable: ${(e as Error).message.slice(0, 80)}`,
    );
  }
  try {
    const lead = { ...sampleJot("aaaaaaaa"), received_at: 1000 };
    await repo.insertJot(lead);
    await repo.insertJot({
      ...sampleJot("bbbbbbbb"),
      anchor: "aaaaaaaa",
      received_at: 2000,
    });
    await repo.mapMessage(7, "aaaaaaaa");
    assert.equal(await repo.jotForMessage(7), "aaaaaaaa");
    assert.equal(await repo.messageForJot("aaaaaaaa"), 7);
    assert.equal(
      (await repo.lastPendingEnrichableJot(lead.note_path, "journal"))?.id,
      "bbbbbbbb",
    );
    assert.deepEqual(
      (await repo.groupFollowers("aaaaaaaa")).map((j) => j.id),
      ["bbbbbbbb"],
    );
    assert.equal(await repo.unsquash("bbbbbbbb"), true);
    assert.deepEqual(
      (await repo.pendingJots()).map((j) => j.id),
      ["aaaaaaaa", "bbbbbbbb"],
    );

    assert.equal(await repo.claim("aaaaaaaa"), true);
    assert.equal(await repo.resetProcessing(), 1);
    await repo.updateJot("aaaaaaaa", { status: "failed", error: "503" });
    assert.deepEqual(
      (await repo.failedJots()).map((j) => j.id),
      ["aaaaaaaa"],
    );
    assert.equal(await repo.resetFailed(false), 1);
    await repo.updateJot("aaaaaaaa", { status: "done" });
    assert.equal((await repo.getJot("aaaaaaaa"))?.status, "done");

    await repo.queueEdit("bbbbbbbb", "s/hi/hello/");
    assert.deepEqual(await repo.queuedEdits("bbbbbbbb"), ["s/hi/hello/"]);
    await repo.clearQueuedEdits("bbbbbbbb");
    assert.deepEqual(await repo.queuedEdits("bbbbbbbb"), []);

    assert.equal(await repo.tilOffered("aaaaaaaa"), false);
    await repo.markTilOffered("aaaaaaaa");
    assert.equal(await repo.tilOffered("aaaaaaaa"), true);

    assert.equal((await repo.windowStats(0, Date.now() + 1000)).total, 2);
    const counts = await repo.statusCounts();
    assert.equal(counts.done, 1);
    assert.equal(counts.pending, 1);
    assert.equal((await repo.recentJots()).length, 2);
    assert.equal((await repo.jotsInRange(0, Date.now() + 1000)).length, 1);
    assert.deepEqual(
      (await repo.jotsPage(0, 5)).map((j) => j.id),
      ["aaaaaaaa"],
    );
    assert.deepEqual(await repo.resetForReprocess(["aaaaaaaa"]), ["aaaaaaaa"]);
    await repo.updateJot("aaaaaaaa", { status: "failed" });
    await repo.resetForRetry("aaaaaaaa");
    assert.equal((await repo.getJot("aaaaaaaa"))?.status, "pending");
    await repo.markDeleted("bbbbbbbb");
    assert.equal((await repo.getJot("bbbbbbbb"))?.status, "deleted");
    await repo.unmapMessage(7);
    assert.equal(await repo.jotForMessage(7), undefined);

    await repo.reject("No", "Norway");
    assert.ok((await repo.rejections()).has("no Norway"));
    assert.deepEqual(await repo.rejectionList(), [
      { surface: "no", note: "Norway" },
    ]);
    assert.equal(await repo.unreject("no", "Norway"), 1);
    await repo.addStopword("Foo");
    assert.ok((await repo.stopwords()).has("foo"));
    assert.ok((await repo.stopwordList()).includes("foo"));
    assert.equal(await repo.delStopword("foo"), 1);
    await repo.addRegisteredLink("Gym", "Fitness");
    assert.deepEqual(await repo.registeredLinks(), [
      { surface: "gym", note: "Fitness" },
    ]);
    assert.equal(await repo.delRegisteredLink("gym", "Fitness"), 1);
    await repo.addPendingLink("pppppppp", "aaaaaaaa", "Lev", "Lev");
    assert.equal((await repo.takePendingLink("pppppppp"))?.note, "Lev");

    await repo.insertTaskDraft({
      id: "d0000001",
      source: "jot",
      jot_id: "aaaaaaaa",
      type: "personal",
      description: "Buy cat sand",
      start: null,
      due: null,
      source_date: "2026-07-06",
      status: "pending",
      chat_id: 42,
      message_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    await repo.updateTaskDraft("d0000001", { type: "work" });
    assert.equal((await repo.getTaskDraft("d0000001"))?.type, "work");
    assert.equal(await repo.claimTaskDraft("d0000001"), true);
    assert.equal(await repo.taskDraftsForJot("aaaaaaaa"), 1);

    assert.deepEqual(await repo.recordRating("2026-07-06", 8), {
      recorded: true,
      current: 8,
    });
    await repo.clearRating("2026-07-06");
    assert.equal((await repo.recordRating("2026-07-06", 5)).recorded, true);
    await repo.setSetting("enrichModel", "m1");
    assert.equal(await repo.getSetting("enrichModel"), "m1");
    assert.equal(await repo.toggleSetting("nightlyRating"), false);
    await repo.seedSettings({ enrichModel: "m2", voiceFixModel: "v1" });
    assert.equal(await repo.getSetting("enrichModel"), "m1");
    assert.equal(await repo.getSetting("voiceFixModel"), "v1");
    assert.equal(await repo.ratingTime("9:30"), "09:30");
  } finally {
    await repo.close();
  }
});

test("a database first migrated by the original release reads back through every repository", async (t) => {
  await withDb(t, async (k) => {
    await k.migrate.rollback(undefined, true);
    await k.migrate.up();
    assert.equal(await k.migrate.currentVersion(), "20260706000000");

    const NOTE = "notes/daily notes/2026-07-06.md";
    const legacy = (id: string, status: string, receivedAt: number) => ({
      id,
      kind: "text",
      note_path: NOTE,
      anchor: id,
      time: "10:00:00",
      raw_text: id,
      status,
      received_at: receivedAt,
      updated_at: receivedAt,
    });
    await k("jots").insert([
      legacy("aaaaaaaa", "pending", 1000),
      legacy("bbbbbbbb", "done", 2000),
    ]);
    await k("msg_map").insert({ tg_message_id: 9, jot_id: "aaaaaaaa" });
    await k("queued_edits").insert({
      jot_id: "aaaaaaaa",
      instruction: "s/a/b/",
      created_at: 1,
    });
    await k("pending_links").insert({
      id: "pppppppp",
      jot_id: "aaaaaaaa",
      surface: "gym",
      note: "Fitness",
      created_at: 1,
    });
    await k("rejections").insert({
      surface: "no",
      note: "Norway",
      created_at: 1,
    });
    await k.migrate.latest();

    const jots = new JotRepository(k);
    assert.equal((await jots.getJot("aaaaaaaa"))?.section, "journal");
    assert.equal(await jots.tilOffered("aaaaaaaa"), false);
    await jots.markTilOffered("aaaaaaaa");
    assert.equal(await jots.tilOffered("aaaaaaaa"), true);
    assert.equal(await jots.tilOffered("bbbbbbbb"), false);
    assert.deepEqual(
      (await jots.pendingJots()).map((j) => j.id),
      ["aaaaaaaa"],
    );
    assert.equal(
      (await jots.lastPendingEnrichableJot(NOTE, "journal"))?.id,
      "aaaaaaaa",
    );
    assert.equal(await jots.lastPendingEnrichableJot(NOTE, "til"), undefined);
    assert.equal(await jots.jotForMessage(9), "aaaaaaaa");
    assert.deepEqual(await jots.queuedEdits("aaaaaaaa"), ["s/a/b/"]);
    const counts = await jots.statusCounts();
    assert.equal(counts.pending, 1);
    assert.equal(counts.done, 1);

    const rules = new LinkRuleRepository(k);
    assert.deepEqual(await rules.takePendingLink("pppppppp"), {
      jot_id: "aaaaaaaa",
      surface: "gym",
      note: "Fitness",
    });
    assert.ok((await rules.rejections()).has("no Norway"));
    assert.ok((await rules.stopwords()).size > 0);
    assert.deepEqual(await rules.registeredLinks(), []);

    assert.equal(
      (await new RatingRepository(k).recordRating("2026-07-06", 7)).recorded,
      true,
    );
    assert.equal(await new SettingsRepository(k).get("enrichModel"), undefined);
    assert.equal(
      await new TaskDraftRepository(k).taskDraftsForJot("aaaaaaaa"),
      0,
    );
  });
});
