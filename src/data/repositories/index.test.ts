import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sampleJot,
  sampleTaskDraft,
  withDb,
  withNative,
} from "../../test/sqlite.ts";
import { Repository } from "./index.ts";
import { JotRepository } from "./jots.ts";
import { LinkRuleRepository } from "./link-rules.ts";
import { RatingRepository } from "./ratings.ts";
import { SettingsRepository } from "./settings.ts";
import { TaskDraftRepository } from "./task-drafts.ts";

test("a jot's life through the Repository aggregate reaches the right table at every step", async (testContext) => {
  await withNative(
    testContext,
    () => Repository.open(":memory:"),
    async (repo) => {
      const lead = { ...sampleJot("aaaaaaaa"), received_at: 1000 };
      await repo.jots.insertJot(lead);
      await repo.jots.insertJot({
        ...sampleJot("bbbbbbbb"),
        anchor: "aaaaaaaa",
        received_at: 2000,
      });
      await repo.jots.mapMessage(7, "aaaaaaaa");
      assert.equal(await repo.jots.jotForMessage(7), "aaaaaaaa");
      assert.equal(await repo.jots.messageForJot("aaaaaaaa"), 7);
      assert.equal(
        (await repo.jots.lastPendingEnrichableJot(lead.note_path, "journal"))
          ?.id,
        "bbbbbbbb",
      );
      assert.deepEqual(
        (await repo.jots.groupFollowers("aaaaaaaa")).map((jot) => jot.id),
        ["bbbbbbbb"],
      );
      assert.equal(await repo.jots.unsquash("bbbbbbbb"), true);
      assert.deepEqual(
        (await repo.jots.pendingJots()).map((jot) => jot.id),
        ["aaaaaaaa", "bbbbbbbb"],
      );

      assert.equal(await repo.jots.claim("aaaaaaaa"), true);
      assert.equal(await repo.jots.resetProcessing(), 1);
      await repo.jots.updateJot("aaaaaaaa", { status: "failed", error: "503" });
      assert.deepEqual(
        (await repo.jots.failedJots()).map((jot) => jot.id),
        ["aaaaaaaa"],
      );
      assert.equal(await repo.jots.resetFailed(false), 1);
      await repo.jots.updateJot("aaaaaaaa", { status: "done" });
      assert.equal((await repo.jots.getJot("aaaaaaaa"))?.status, "done");

      await repo.jots.queueEdit("bbbbbbbb", "s/hi/hello/");
      assert.deepEqual(await repo.jots.queuedEdits("bbbbbbbb"), [
        "s/hi/hello/",
      ]);
      await repo.jots.clearQueuedEdits("bbbbbbbb");
      assert.deepEqual(await repo.jots.queuedEdits("bbbbbbbb"), []);

      assert.equal(await repo.jots.tilOffered("aaaaaaaa"), false);
      await repo.jots.markTilOffered("aaaaaaaa");
      assert.equal(await repo.jots.tilOffered("aaaaaaaa"), true);

      assert.equal(
        (await repo.jots.windowStats(0, Date.now() + 1000)).total,
        2,
      );
      const counts = await repo.jots.statusCounts();
      assert.equal(counts.done, 1);
      assert.equal(counts.pending, 1);
      assert.equal((await repo.jots.recentJots()).length, 2);
      assert.equal(
        (await repo.jots.jotsInRange(0, Date.now() + 1000)).length,
        1,
      );
      assert.deepEqual(
        (await repo.jots.jotsPage(0, 5)).map((jot) => jot.id),
        ["aaaaaaaa"],
      );
      assert.deepEqual(await repo.jots.resetForReprocess(["aaaaaaaa"]), [
        "aaaaaaaa",
      ]);
      await repo.jots.updateJot("aaaaaaaa", { status: "failed" });
      await repo.jots.resetForRetry("aaaaaaaa");
      assert.equal((await repo.jots.getJot("aaaaaaaa"))?.status, "pending");
      await repo.jots.markDeleted("bbbbbbbb");
      assert.equal((await repo.jots.getJot("bbbbbbbb"))?.status, "deleted");
      await repo.jots.unmapMessage(7);
      assert.equal(await repo.jots.jotForMessage(7), undefined);

      await repo.linkRules.reject("No", "Norway");
      assert.ok((await repo.linkRules.rejections()).has("no Norway"));
      assert.deepEqual(await repo.linkRules.rejectionList(), [
        { surface: "no", note: "Norway" },
      ]);
      assert.equal(await repo.linkRules.unreject("no", "Norway"), 1);
      await repo.linkRules.addStopword("Foo");
      assert.ok((await repo.linkRules.stopwords()).has("foo"));
      assert.ok((await repo.linkRules.stopwordList()).includes("foo"));
      assert.equal(await repo.linkRules.delStopword("foo"), 1);
      await repo.linkRules.addRegisteredLink("Gym", "Fitness");
      assert.deepEqual(await repo.linkRules.registeredLinks(), [
        { surface: "gym", note: "Fitness" },
      ]);
      assert.equal(await repo.linkRules.delRegisteredLink("gym", "Fitness"), 1);
      await repo.linkRules.addPendingLink("pppppppp", "aaaaaaaa", "Lev", "Lev");
      assert.equal(
        (await repo.linkRules.takePendingLink("pppppppp"))?.note,
        "Lev",
      );

      await repo.taskDrafts.insertTaskDraft(
        sampleTaskDraft("d0000001", {
          source: "jot",
          jot_id: "aaaaaaaa",
          due: null,
          source_date: "2026-07-06",
          chat_id: 42,
          message_id: null,
        }),
      );
      await repo.taskDrafts.updateTaskDraft("d0000001", { type: "work" });
      assert.equal(
        (await repo.taskDrafts.getTaskDraft("d0000001"))?.type,
        "work",
      );
      assert.equal(await repo.taskDrafts.claimTaskDraft("d0000001"), true);
      assert.equal(await repo.taskDrafts.taskDraftsForJot("aaaaaaaa"), 1);

      assert.deepEqual(await repo.ratings.recordRating("2026-07-06", 8), {
        recorded: true,
        current: 8,
      });
      await repo.ratings.clearRating("2026-07-06");
      assert.equal(
        (await repo.ratings.recordRating("2026-07-06", 5)).recorded,
        true,
      );
      await repo.settings.setSetting("enrichModel", "m1");
      assert.equal(await repo.settings.getSetting("enrichModel"), "m1");
      assert.equal(await repo.settings.toggleSetting("nightlyRating"), false);
      await repo.settings.seedSettings({
        enrichModel: "m2",
        voiceFixModel: "v1",
      });
      assert.equal(await repo.settings.getSetting("enrichModel"), "m1");
      assert.equal(await repo.settings.getSetting("voiceFixModel"), "v1");
      assert.equal(await repo.settings.ratingTime("9:30"), "09:30");
    },
  );
});

test("a database first migrated by the original release reads back through every repository", async (testContext) => {
  await withDb(testContext, async (knex) => {
    await knex.migrate.rollback(undefined, true);
    await knex.migrate.up();
    assert.equal(await knex.migrate.currentVersion(), "20260706000000");

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
    await knex("jots").insert([
      legacy("aaaaaaaa", "pending", 1000),
      legacy("bbbbbbbb", "done", 2000),
    ]);
    await knex("msg_map").insert({ tg_message_id: 9, jot_id: "aaaaaaaa" });
    await knex("queued_edits").insert({
      jot_id: "aaaaaaaa",
      instruction: "s/a/b/",
      created_at: 1,
    });
    await knex("pending_links").insert({
      id: "pppppppp",
      jot_id: "aaaaaaaa",
      surface: "gym",
      note: "Fitness",
      created_at: 1,
    });
    await knex("rejections").insert({
      surface: "no",
      note: "Norway",
      created_at: 1,
    });
    await knex.migrate.latest();

    const jots = new JotRepository(knex);
    assert.equal((await jots.getJot("aaaaaaaa"))?.section, "journal");
    assert.equal(await jots.tilOffered("aaaaaaaa"), false);
    await jots.markTilOffered("aaaaaaaa");
    assert.equal(await jots.tilOffered("aaaaaaaa"), true);
    assert.equal(await jots.tilOffered("bbbbbbbb"), false);
    assert.deepEqual(
      (await jots.pendingJots()).map((jot) => jot.id),
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

    const rules = new LinkRuleRepository(knex);
    assert.deepEqual(await rules.takePendingLink("pppppppp"), {
      jot_id: "aaaaaaaa",
      surface: "gym",
      note: "Fitness",
    });
    assert.ok((await rules.rejections()).has("no Norway"));
    assert.ok((await rules.stopwords()).size > 0);
    assert.deepEqual(await rules.registeredLinks(), []);

    assert.equal(
      (await new RatingRepository(knex).recordRating("2026-07-06", 7)).recorded,
      true,
    );
    assert.equal(
      await new SettingsRepository(knex).getSetting("enrichModel"),
      undefined,
    );
    assert.equal(
      await new TaskDraftRepository(knex).taskDraftsForJot("aaaaaaaa"),
      0,
    );
  });
});
