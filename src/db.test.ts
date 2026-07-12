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
		assert.deepEqual(await repo.queuedEdits("aaaaaaaa"), ["s/a/b/", "delete"]);
		assert.deepEqual(await repo.queuedEdits("aaaaaaaa"), ["s/a/b/", "delete"]); // peek doesn't consume
		await repo.clearQueuedEdits("aaaaaaaa");
		assert.deepEqual(await repo.queuedEdits("aaaaaaaa"), []); // cleared only on demand

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

		// windowStats: full kind/outcome breakdown over the window (also drives the daily summary)
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

		// recentJots (the /menu browser): newest first by received_at, deleted excluded
		await repo.insertJot({
			...sampleJot("dddddddd"),
			received_at: Date.now() + 5000,
		});
		await repo.markDeleted("aaaaaaaa");
		const recent = (await repo.recentJots()).map((j) => j.id);
		assert.equal(recent[0], "dddddddd"); // highest received_at leads
		assert.ok(!recent.includes("aaaaaaaa")); // deleted is excluded
		assert.ok(recent.includes("bbbbbbbb") && recent.includes("cccccccc"));

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

		// registered links: add is idempotent + stores surface lowercased, del reports rows
		await repo.addRegisteredLink("Gym", "Fitness");
		await repo.addRegisteredLink("gym", "Fitness"); // dup ignored
		assert.deepEqual(await repo.registeredLinks(), [
			{ surface: "gym", note: "Fitness" },
		]);
		assert.equal(await repo.delRegisteredLink("GYM", "Fitness"), 1);
		assert.equal((await repo.registeredLinks()).length, 0);

		// settings: upsert + read
		assert.equal(await repo.getSetting("transcriber"), undefined);
		await repo.setSetting("transcriber", "remote");
		assert.equal(await repo.getSetting("transcriber"), "remote");
		await repo.setSetting("transcriber", "local"); // merge on conflict
		assert.equal(await repo.getSetting("transcriber"), "local");

		// squash queries. lastPendingEnrichableJot: newest still-pending text/voice jot in
		// a note, ignoring attach-only kinds. groupFollowers: same-anchor followers,
		// oldest-first, leader + deleted excluded.
		const NOTE = "notes/daily notes/2026-07-09.md";
		await repo.insertJot({
			...sampleJot("11111111"),
			note_path: NOTE,
			received_at: 1000,
		}); // leader (text)
		await repo.insertJot({
			...sampleJot("22222222"),
			note_path: NOTE,
			kind: "audio",
			anchor: "11111111",
			received_at: 2000,
		}); // follower shares leader's anchor
		await repo.insertJot({
			...sampleJot("33333333"),
			note_path: NOTE,
			kind: "image",
			received_at: 9000,
		}); // attach-only — never a run head
		assert.equal((await repo.lastPendingEnrichableJot(NOTE))?.id, "22222222"); // newest pending enrichable; image skipped
		assert.deepEqual(
			(await repo.groupFollowers("11111111")).map((j) => j.id),
			["22222222"],
		);
		await repo.updateJot("22222222", { status: "done" }); // no longer an open run head
		assert.equal((await repo.lastPendingEnrichableJot(NOTE))?.id, "11111111");
		await repo.markDeleted("22222222");
		assert.deepEqual(await repo.groupFollowers("11111111"), []); // deleted drops out

		// unsquash: the 🤝 merge opt-out. Only wins while the follower is still pending;
		// atomic compare-and-swap like claim(), so it can't resurrect an already-merged jot.
		await repo.insertJot({
			...sampleJot("44444444"),
			note_path: NOTE,
			anchor: "11111111",
			received_at: 3000,
		}); // a fresh follower
		assert.equal(await repo.unsquash("44444444"), true);
		assert.equal((await repo.getJot("44444444"))?.anchor, "44444444"); // now its own leader
		assert.equal(await repo.unsquash("44444444"), false); // already standalone — no-op
		await repo.insertJot({
			...sampleJot("55555555"),
			note_path: NOTE,
			anchor: "11111111",
			status: "done",
			received_at: -1, // outside the /reprocess range test below
		}); // already merged by the time the opt-out arrives
		assert.equal(await repo.unsquash("55555555"), false);
		assert.equal((await repo.getJot("55555555"))?.anchor, "11111111"); // left alone

		// /reprocess queries: jotsInRange (day/range pickers), jotsPage (the "one jot"
		// browser), resetForReprocess (bulk reset by explicit id set).
		const RP_NOTE = "notes/daily notes/2026-07-08.md";
		await repo.insertJot({
			...sampleJot("eeeeeeee"),
			note_path: RP_NOTE,
			status: "done",
			received_at: 5000,
		});
		await repo.insertJot({
			...sampleJot("ffffffff"),
			note_path: RP_NOTE,
			status: "abandoned",
			received_at: 6000,
		});
		await repo.insertJot({
			...sampleJot("11122233"), // in-flight — excluded from reprocess candidates
			note_path: RP_NOTE,
			status: "processing",
			received_at: 7000,
		});
		assert.deepEqual(
			(await repo.jotsInRange(0, 10_000)).map((j) => j.id),
			["eeeeeeee", "ffffffff"], // processing excluded, oldest first
		);
		assert.deepEqual(
			(await repo.jotsPage(0, 1)).map((j) => j.id),
			["ffffffff"], // newest first
		);
		assert.deepEqual(
			await repo.resetForReprocess(["eeeeeeee", "11122233", "nonexistent"]),
			["eeeeeeee"], // only the eligible (done) id among the given set is touched
		);
		assert.equal((await repo.getJot("eeeeeeee"))?.status, "pending");
		assert.equal((await repo.getJot("eeeeeeee"))?.attempts, 0);
		assert.equal((await repo.getJot("11122233"))?.status, "processing"); // untouched
	} finally {
		await repo.close();
		await rm(dbPath, { force: true });
		await rm(`${dbPath}-shm`, { force: true });
		await rm(`${dbPath}-wal`, { force: true });
	}
});
