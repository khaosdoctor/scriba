import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleJot, withDb, withNative } from "../../test/sqlite.ts";
import { openDb } from "../connections/sqlite.ts";
import { JotRepository } from "./jots.ts";

test("jots: insert, update, retry cap, claim, message map and queued edits", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    const jot = sampleJot("aaaaaaaa");
    await jots.insertJot(jot);
    assert.equal((await jots.getJot("aaaaaaaa"))?.raw_text, "hi");

    await jots.updateJot("aaaaaaaa", { status: "done" });
    assert.equal((await jots.getJot("aaaaaaaa"))?.status, "done");

    await jots.insertJot({ ...sampleJot("bbbbbbbb"), status: "failed" });
    assert.deepEqual(
      (await jots.pendingJots()).map((row) => row.id),
      ["bbbbbbbb"],
    );

    // failed jot at the retry cap is no longer eligible
    await jots.insertJot({
      ...sampleJot("cccccccc"),
      status: "failed",
      attempts: 10,
    });
    assert.ok(!(await jots.pendingJots()).some((row) => row.id === "cccccccc"));

    // atomic claim: wins once, then the jot is `processing` and no longer pending
    assert.equal(await jots.claim("bbbbbbbb"), true);
    assert.equal(await jots.claim("bbbbbbbb"), false); // already claimed
    assert.ok(!(await jots.pendingJots()).some((row) => row.id === "bbbbbbbb"));
    await jots.resetProcessing(); // crash recovery restores it
    assert.ok((await jots.pendingJots()).some((row) => row.id === "bbbbbbbb"));

    await jots.mapMessage(42, "aaaaaaaa");
    assert.equal(await jots.jotForMessage(42), "aaaaaaaa");
    assert.equal(await jots.messageForJot("aaaaaaaa"), 42); // reverse lookup for outcome reactions
    assert.equal(await jots.messageForJot("nope"), undefined);

    await jots.queueEdit("aaaaaaaa", "s/a/b/");
    await jots.queueEdit("aaaaaaaa", "delete");
    assert.deepEqual(await jots.queuedEdits("aaaaaaaa"), ["s/a/b/", "delete"]);
    assert.deepEqual(await jots.queuedEdits("aaaaaaaa"), ["s/a/b/", "delete"]); // peek doesn't consume
    await jots.clearQueuedEdits("aaaaaaaa");
    assert.deepEqual(await jots.queuedEdits("aaaaaaaa"), []); // cleared only on demand
  });
});

test("a deleted status message stops resolving to its jot", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    await jots.insertJot(sampleJot("aaaaaaaa"));
    await jots.mapMessage(42, "aaaaaaaa");
    await jots.mapMessage(43, "aaaaaaaa");

    await jots.unmapMessage(42);
    assert.equal(await jots.jotForMessage(42), undefined);
    assert.equal(await jots.jotForMessage(43), "aaaaaaaa");
  });
});

test("resetForRetry sends a failed jot back to pending with its attempts and error cleared", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    await jots.insertJot({
      ...sampleJot("aaaaaaaa"),
      status: "failed",
      attempts: 3,
      error: "Obsidian 503",
    });

    await jots.resetForRetry("aaaaaaaa");
    const jot = await jots.getJot("aaaaaaaa");
    assert.equal(jot?.status, "pending");
    assert.equal(jot?.attempts, 0);
    assert.equal(jot?.error, null);
  });
});

test("resetForRetry leaves a jot being processed, or a deleted one, alone", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    await jots.insertJot({
      ...sampleJot("aaaaaaaa"),
      status: "processing",
      attempts: 2,
    });
    await jots.insertJot({ ...sampleJot("bbbbbbbb"), status: "deleted" });
    await jots.insertJot({
      ...sampleJot("cccccccc"),
      status: "failed",
      attempts: 3,
    });

    assert.equal(await jots.resetForRetry("aaaaaaaa"), false);
    assert.equal((await jots.getJot("aaaaaaaa"))?.status, "processing");
    assert.equal((await jots.getJot("aaaaaaaa"))?.attempts, 2);
    assert.equal(await jots.resetForRetry("bbbbbbbb"), false);
    assert.equal((await jots.getJot("bbbbbbbb"))?.status, "deleted");
    assert.equal(await jots.resetForRetry("cccccccc"), true);
    assert.equal((await jots.getJot("cccccccc"))?.status, "pending");
  });
});

test("windowStats and statusCounts break down the live table", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    await jots.insertJot({ ...sampleJot("aaaaaaaa"), status: "done" });
    await jots.insertJot({ ...sampleJot("bbbbbbbb"), status: "pending" });
    await jots.insertJot({ ...sampleJot("cccccccc"), status: "failed" });

    // windowStats: full kind/outcome breakdown over the window (also drives the daily summary)
    const win = await jots.windowStats(0, Date.now() + 1000);
    assert.equal(win.total, 3);
    assert.equal(win.text, 3); // all sample jots are kind "text"
    assert.equal(win.done, 1); // aaaa
    assert.equal(win.failed, 1); // cccc

    // statusCounts: live table counts
    const counts = await jots.statusCounts();
    assert.equal(counts.done, 1);
    assert.equal(counts.pending, 1); // bbbb is still pending
    assert.equal(counts.failed, 1);
  });
});

test("failedJots + resetFailed: a failed-at-cap jot is reset to pending", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    await jots.insertJot({
      ...sampleJot("cccccccc"),
      status: "failed",
      attempts: 10,
    });

    assert.deepEqual(
      (await jots.failedJots()).map((row) => row.id),
      ["cccccccc"],
    );
    assert.equal(await jots.resetFailed(false), 1);
    assert.equal((await jots.getJot("cccccccc"))?.status, "pending");
    assert.equal((await jots.getJot("cccccccc"))?.attempts, 0);
  });
});

test("recentJots lists newest first and excludes deleted jots", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    await jots.insertJot(sampleJot("aaaaaaaa"));
    await jots.insertJot({ ...sampleJot("bbbbbbbb"), status: "pending" });
    await jots.insertJot({ ...sampleJot("cccccccc"), status: "pending" });
    await jots.insertJot({
      ...sampleJot("dddddddd"),
      received_at: Date.now() + 5000,
    });
    await jots.markDeleted("aaaaaaaa");

    // recentJots (the /menu browser): newest first by received_at, deleted excluded
    const recent = (await jots.recentJots()).map((row) => row.id);
    assert.equal(recent[0], "dddddddd"); // highest received_at leads
    assert.ok(!recent.includes("aaaaaaaa")); // deleted is excluded
    assert.ok(recent.includes("bbbbbbbb") && recent.includes("cccccccc"));
  });
});

test("squash queries: lastPendingEnrichableJot and groupFollowers", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    // squash queries. lastPendingEnrichableJot: newest still-pending text/voice jot in
    // a note, ignoring attach-only kinds. groupFollowers: same-anchor followers,
    // oldest-first, leader + deleted excluded.
    const NOTE = "notes/daily notes/2026-07-09.md";
    await jots.insertJot({
      ...sampleJot("11111111"),
      note_path: NOTE,
      received_at: 1000,
    }); // leader (text)
    await jots.insertJot({
      ...sampleJot("22222222"),
      note_path: NOTE,
      kind: "audio",
      anchor: "11111111",
      received_at: 2000,
    }); // follower shares leader's anchor
    await jots.insertJot({
      ...sampleJot("33333333"),
      note_path: NOTE,
      kind: "image",
      received_at: 9000,
    }); // attach-only, never a run head
    assert.equal(
      (await jots.lastPendingEnrichableJot(NOTE, "journal"))?.id,
      "22222222",
    ); // newest pending enrichable; image skipped
    assert.deepEqual(
      (await jots.groupFollowers("11111111")).map((row) => row.id),
      ["22222222"],
    );
    await jots.updateJot("22222222", { status: "done" }); // no longer an open run head
    assert.equal(
      (await jots.lastPendingEnrichableJot(NOTE, "journal"))?.id,
      "11111111",
    );
    // a newer TIL jot is invisible to the journal run and vice versa
    await jots.insertJot({
      ...sampleJot("66666666"),
      note_path: NOTE,
      section: "til",
      received_at: -2,
    });
    assert.equal(
      (await jots.lastPendingEnrichableJot(NOTE, "journal"))?.id,
      "11111111",
    );
    assert.equal(
      (await jots.lastPendingEnrichableJot(NOTE, "til"))?.id,
      "66666666",
    );
    await jots.updateJot("66666666", { status: "done" });
    assert.equal(await jots.lastPendingEnrichableJot(NOTE, "til"), undefined);
    await jots.markDeleted("22222222");
    assert.deepEqual(await jots.groupFollowers("11111111"), []); // deleted drops out
  });
});

test("unsquash wins only while the follower is still pending", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    const NOTE = "notes/daily notes/2026-07-09.md";
    // unsquash: the 🤝 merge opt-out. Only wins while the follower is still pending;
    // atomic compare-and-swap like claim(), so it can't resurrect an already-merged jot.
    await jots.insertJot({
      ...sampleJot("44444444"),
      note_path: NOTE,
      anchor: "11111111",
      received_at: 3000,
    }); // a fresh follower
    assert.equal(await jots.unsquash("44444444"), true);
    assert.equal((await jots.getJot("44444444"))?.anchor, "44444444"); // now its own leader
    assert.equal(await jots.unsquash("44444444"), false); // already standalone, no-op
    await jots.insertJot({
      ...sampleJot("55555555"),
      note_path: NOTE,
      anchor: "11111111",
      status: "done",
      received_at: -1,
    }); // already merged by the time the opt-out arrives
    assert.equal(await jots.unsquash("55555555"), false);
    assert.equal((await jots.getJot("55555555"))?.anchor, "11111111"); // left alone
  });
});

test("reprocess queries: jotsInRange, jotsPage and resetForReprocess", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    // /reprocess queries: jotsInRange (day/range pickers), jotsPage (the "one jot"
    // browser), resetForReprocess (bulk reset by explicit id set).
    const RP_NOTE = "notes/daily notes/2026-07-08.md";
    await jots.insertJot({
      ...sampleJot("eeeeeeee"),
      note_path: RP_NOTE,
      status: "done",
      received_at: 5000,
    });
    await jots.insertJot({
      ...sampleJot("ffffffff"),
      note_path: RP_NOTE,
      status: "abandoned",
      received_at: 6000,
    });
    await jots.insertJot({
      ...sampleJot("11122233"), // in-flight, excluded from reprocess candidates
      note_path: RP_NOTE,
      status: "processing",
      received_at: 7000,
    });
    assert.deepEqual(
      (await jots.jotsInRange(0, 10_000)).map((row) => row.id),
      ["eeeeeeee", "ffffffff"], // processing excluded, oldest first
    );
    assert.deepEqual(
      (await jots.jotsPage(0, 1)).map((row) => row.id),
      ["ffffffff"], // newest first
    );
    assert.deepEqual(
      await jots.resetForReprocess(["eeeeeeee", "11122233", "nonexistent"]),
      ["eeeeeeee"], // only the eligible (done) id among the given set is touched
    );
    assert.equal((await jots.getJot("eeeeeeee"))?.status, "pending");
    assert.equal((await jots.getJot("eeeeeeee"))?.attempts, 0);
    assert.equal((await jots.getJot("11122233"))?.status, "processing"); // untouched
  });
});

test("the offered flag is per jot, strictly boolean, and survives edits and a reprocess reset", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    assert.equal(await jots.tilOffered("ffffffff"), false); // no such jot
    await jots.insertJot(sampleJot("aaaaaaaa"));
    await jots.insertJot(sampleJot("bbbbbbbb"));
    assert.equal(await jots.tilOffered("aaaaaaaa"), false);

    const before = await jots.getJot("aaaaaaaa");
    await jots.markTilOffered("aaaaaaaa");
    const offered = await jots.tilOffered("aaaaaaaa");
    assert.equal(typeof offered, "boolean");
    assert.equal(offered, true);
    assert.equal(await jots.tilOffered("bbbbbbbb"), false);

    const after = await jots.getJot("aaaaaaaa");
    assert.equal(after?.status, before?.status);
    assert.equal(after?.raw_text, before?.raw_text);
    assert.equal(after?.section, before?.section);

    await jots.updateJot("aaaaaaaa", { raw_text: "x", status: "pending" });
    await jots.resetForReprocess(["aaaaaaaa"]);
    assert.equal(await jots.tilOffered("aaaaaaaa"), true);
  });
});

test("squash lookups stay inside their section", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const jots = new JotRepository(knex);
    const NOTE = "notes/daily notes/2026-07-09.md";
    await jots.insertJot({
      ...sampleJot("aaaaaaaa"),
      note_path: NOTE,
      received_at: 1000,
    });
    await jots.insertJot({
      ...sampleJot("bbbbbbbb"),
      note_path: NOTE,
      section: "til",
      received_at: 2000,
    });
    assert.equal(
      (await jots.lastPendingEnrichableJot(NOTE, "journal"))?.id,
      "aaaaaaaa",
    );
    await jots.insertJot({
      ...sampleJot("cccccccc"),
      note_path: NOTE,
      received_at: 3000,
    });
    assert.equal(
      (await jots.lastPendingEnrichableJot(NOTE, "journal"))?.id,
      "cccccccc",
    );
    assert.equal(
      (await jots.lastPendingEnrichableJot(NOTE, "til"))?.id,
      "bbbbbbbb",
    );
  });
});

test("reopening a migrated database applies nothing and keeps the section", async (testContext) => {
  const seedThenReopen = async (dbPath: string) => {
    const first = await openDb(dbPath);
    await new JotRepository(first).insertJot({
      ...sampleJot("aaaaaaaa"),
      section: "til",
    });
    await first.destroy();
    return openDb(dbPath);
  };
  await withNative(testContext, seedThenReopen, async (knex) => {
    const second = new JotRepository(knex);
    assert.equal((await second.getJot("aaaaaaaa"))?.section, "til");
  });
});
