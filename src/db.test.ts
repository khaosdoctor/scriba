import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Repository, type Jot } from "./db.ts";

function sampleJot(id: string): Jot {
  const now = Date.now();
  return {
    id, kind: "text", note_path: "notes/daily notes/2026-07-06.md", anchor: id,
    time: "10:00:00", raw_text: "hi", transcript: null, asset_path: null, file_id: null,
    status: "pending", attempts: 0, error: null, received_at: now, updated_at: now,
  };
}

test("repository roundtrip (skipped when better-sqlite3 can't build)", async (t) => {
  const dbPath = join(tmpdir(), `scriba-test-${randomBytes(6).toString("hex")}.db`);
  let repo: Repository;
  try {
    repo = await Repository.open(dbPath);
  } catch (e) {
    return t.skip(`native sqlite unavailable: ${(e as Error).message.slice(0, 80)}`);
  }
  try {
    const jot = sampleJot("aaaaaaaa");
    await repo.insertJot(jot);
    assert.equal((await repo.getJot("aaaaaaaa"))?.raw_text, "hi");

    await repo.updateJot("aaaaaaaa", { status: "done" });
    assert.equal((await repo.getJot("aaaaaaaa"))?.status, "done");

    await repo.insertJot({ ...sampleJot("bbbbbbbb"), status: "failed" });
    assert.deepEqual((await repo.pendingJots()).map((j) => j.id), ["bbbbbbbb"]);

    // failed jot at the retry cap is no longer eligible
    await repo.insertJot({ ...sampleJot("cccccccc"), status: "failed", attempts: 10 });
    assert.ok(!(await repo.pendingJots()).some((j) => j.id === "cccccccc"));

    // atomic claim: wins once, then the jot is `processing` and no longer pending
    assert.equal(await repo.claim("bbbbbbbb"), true);
    assert.equal(await repo.claim("bbbbbbbb"), false); // already claimed
    assert.ok(!(await repo.pendingJots()).some((j) => j.id === "bbbbbbbb"));
    await repo.resetProcessing(); // crash recovery restores it
    assert.ok((await repo.pendingJots()).some((j) => j.id === "bbbbbbbb"));

    await repo.mapMessage(42, "aaaaaaaa");
    assert.equal(await repo.jotForMessage(42), "aaaaaaaa");

    await repo.reject("No", "Norway");
    assert.ok((await repo.rejections()).has("no Norway")); // stored lowercased

    assert.ok((await repo.stopwords()).size > 0); // seeded by migration

    await repo.addPendingLink("pppppppp", "aaaaaaaa", "Lev", "Lev");
    assert.equal((await repo.takePendingLink("pppppppp"))?.note, "Lev");
    assert.equal(await repo.takePendingLink("pppppppp"), undefined); // consumed

    await repo.queueEdit("aaaaaaaa", "s/a/b/");
    await repo.queueEdit("aaaaaaaa", "delete");
    assert.deepEqual(await repo.takeQueuedEdits("aaaaaaaa"), ["s/a/b/", "delete"]);
    assert.deepEqual(await repo.takeQueuedEdits("aaaaaaaa"), []); // cleared

    const stats = await repo.dayStats(0, Date.now() + 1000);
    assert.equal(stats.jots, 3);          // aaaa(done) + bbbb(pending) + cccc(failed)
    assert.equal(stats.failed, 1);        // only cccccccc is still failed/abandoned
  } finally {
    await repo.close();
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
  }
});
