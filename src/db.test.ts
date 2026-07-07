import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Jot, Repository } from "./db.ts";

function sampleJot(id: string): Jot {
	const now = Date.now();
	return {
		id,
		kind: "text",
		note_path: "notes/daily notes/2026-07-06.md",
		anchor: id,
		time: "10:00:00",
		raw_text: "hi",
		transcript: null,
		asset_path: null,
		file_id: null,
		status: "pending",
		attempts: 0,
		error: null,
		received_at: now,
		updated_at: now,
	};
}

test("repository roundtrip (skipped when better-sqlite3 can't build)", async (t) => {
	const dbPath = join(
		tmpdir(),
		`scriba-test-${randomBytes(6).toString("hex")}.db`,
	);
	let repo: Repository;
	try {
		repo = await Repository.open(dbPath);
	} catch (e) {
		return t.skip(
			`native sqlite unavailable: ${(e as Error).message.slice(0, 80)}`,
		);
	}
	try {
		const jot = sampleJot("aaaaaaaa");
		await repo.insertJot(jot);
		assert.equal((await repo.getJot("aaaaaaaa"))?.raw_text, "hi");

		await repo.updateJot("aaaaaaaa", { status: "done" });
		assert.equal((await repo.getJot("aaaaaaaa"))?.status, "done");

		await repo.insertJot({ ...sampleJot("bbbbbbbb"), status: "failed" });
		assert.deepEqual(
			(await repo.pendingJots()).map((j) => j.id),
			["bbbbbbbb"],
		);

		// failed jot at the retry cap is no longer eligible
		await repo.insertJot({
			...sampleJot("cccccccc"),
			status: "failed",
			attempts: 10,
		});
		assert.ok(!(await repo.pendingJots()).some((j) => j.id === "cccccccc"));

		// atomic claim: wins once, then the jot is `processing` and no longer pending
		assert.equal(await repo.claim("bbbbbbbb"), true);
		assert.equal(await repo.claim("bbbbbbbb"), false); // already claimed
		assert.ok(!(await repo.pendingJots()).some((j) => j.id === "bbbbbbbb"));
		await repo.resetProcessing(); // crash recovery restores it
		assert.ok((await repo.pendingJots()).some((j) => j.id === "bbbbbbbb"));

		await repo.mapMessage(42, "aaaaaaaa");
		assert.equal(await repo.jotForMessage(42), "aaaaaaaa");
		assert.equal(await repo.messageForJot("aaaaaaaa"), 42); // reverse lookup for outcome reactions
		assert.equal(await repo.messageForJot("nope"), undefined);

		await repo.reject("No", "Norway");
		assert.ok((await repo.rejections()).has("no Norway")); // stored lowercased

		assert.ok((await repo.stopwords()).size > 0); // seeded by migration

		await repo.addPendingLink("pppppppp", "aaaaaaaa", "Lev", "Lev");
		assert.equal((await repo.takePendingLink("pppppppp"))?.note, "Lev");
		assert.equal(await repo.takePendingLink("pppppppp"), undefined); // consumed

		await repo.queueEdit("aaaaaaaa", "s/a/b/");
		await repo.queueEdit("aaaaaaaa", "delete");
		assert.deepEqual(await repo.takeQueuedEdits("aaaaaaaa"), [
			"s/a/b/",
			"delete",
		]);
		assert.deepEqual(await repo.takeQueuedEdits("aaaaaaaa"), []); // cleared

		// rating gate: first record wins, second is rejected with the existing value
		assert.deepEqual(await repo.recordRating("2026-07-06", 8), {
			recorded: true,
			current: 8,
		});
		assert.deepEqual(await repo.recordRating("2026-07-06", 3), {
			recorded: false,
			current: 8,
		});
		await repo.clearRating("2026-07-06");
		assert.deepEqual(await repo.recordRating("2026-07-06", 3), {
			recorded: true,
			current: 3,
		});

		const stats = await repo.dayStats(0, Date.now() + 1000);
		assert.equal(stats.jots, 3); // aaaa(done) + bbbb(pending) + cccc(failed)
		assert.equal(stats.failed, 1); // only cccccccc is still failed/abandoned

		// windowStats: full kind/outcome breakdown over the window
		const win = await repo.windowStats(0, Date.now() + 1000);
		assert.equal(win.total, 3);
		assert.equal(win.text, 3); // all sample jots are kind "text"
		assert.equal(win.done, 1); // aaaa
		assert.equal(win.failed, 1); // cccc

		// statusCounts: live table counts
		const counts = await repo.statusCounts();
		assert.equal(counts.done, 1);
		assert.equal(counts.pending, 1); // bbbb was reset to pending above
		assert.equal(counts.failed, 1);

		// failedJots + resetFailed: cccccccc is failed-at-cap; reset makes it pending
		assert.deepEqual(
			(await repo.failedJots()).map((j) => j.id),
			["cccccccc"],
		);
		assert.equal(await repo.resetFailed(false), 1);
		assert.equal((await repo.getJot("cccccccc"))?.status, "pending");
		assert.equal((await repo.getJot("cccccccc"))?.attempts, 0);

		// stopwords: add is idempotent, del reports how many rows went
		await repo.addStopword("Foo");
		await repo.addStopword("foo"); // dup ignored
		assert.ok((await repo.stopwords()).has("foo"));
		assert.equal(await repo.delStopword("FOO"), 1);
		assert.ok(!(await repo.stopwords()).has("foo"));

		// rejections: list + undo (reject stores surface lowercased)
		assert.deepEqual(await repo.rejectionList(), [
			{ surface: "no", note: "Norway" },
		]);
		assert.equal(await repo.unreject("No", "Norway"), 1);
		assert.equal((await repo.rejectionList()).length, 0);

		// settings: upsert + read
		assert.equal(await repo.getSetting("transcriber"), undefined);
		await repo.setSetting("transcriber", "remote");
		assert.equal(await repo.getSetting("transcriber"), "remote");
		await repo.setSetting("transcriber", "local"); // merge on conflict
		assert.equal(await repo.getSetting("transcriber"), "local");
	} finally {
		await repo.close();
		await rm(dbPath, { force: true });
		await rm(`${dbPath}-shm`, { force: true });
		await rm(`${dbPath}-wal`, { force: true });
	}
});
