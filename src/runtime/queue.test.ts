import assert from "node:assert/strict";
import { test } from "node:test";
import { FlushQueue } from "./queue.ts";

function make(
	overrides: Partial<{
		idleMs: number;
		maxBatch: number;
		maxWaitMs: number;
	}> = {},
) {
	const flushed: string[][] = [];
	const q = new FlushQueue({
		idleMs: 100,
		maxBatch: 3,
		maxWaitMs: 500,
		onFlush: async (ids) => {
			flushed.push(ids);
		},
		...overrides,
	});
	return { q, flushed };
}

test("flushes immediately when the batch-size cap is hit", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { q, flushed } = make({ maxBatch: 3 });
	q.add("a");
	q.add("b");
	assert.equal(flushed.length, 0);
	q.add("c"); // hits cap → synchronous flush
	assert.deepEqual(flushed, [["a", "b", "c"]]);
});

test("flushes after the idle gap", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { q, flushed } = make({ idleMs: 100 });
	q.add("a");
	t.mock.timers.tick(99);
	assert.equal(flushed.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(flushed, [["a"]]);
});

test("idle timer resets on each new message", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { q, flushed } = make({ idleMs: 100, maxWaitMs: 10_000 });
	q.add("a");
	t.mock.timers.tick(80);
	q.add("b"); // resets idle
	t.mock.timers.tick(80);
	assert.equal(flushed.length, 0); // 80 < 100 since last add
	t.mock.timers.tick(20);
	assert.deepEqual(flushed, [["a", "b"]]);
});

test("hard max-wait fires even under a steady trickle", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { q, flushed } = make({ idleMs: 1000, maxBatch: 99, maxWaitMs: 200 });
	q.add("a");
	t.mock.timers.tick(150);
	q.add("b"); // resets idle (1000) but not the max-wait
	t.mock.timers.tick(50); // 200 total since first item
	assert.deepEqual(flushed, [["a", "b"]]);
});

test("addMany pushes the whole batch and arms once, same as add() for the cap", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { q, flushed } = make({ maxBatch: 3 });
	q.addMany(["a", "b", "c"]); // hits cap in one call → synchronous flush
	assert.deepEqual(flushed, [["a", "b", "c"]]);
});

test("addMany chunks a batch larger than maxBatch into multiple flushes", async () => {
	// Real timers here: the cap-triggered flushes chain through arm() -> flush() ->
	// arm() via promise microtasks, not the mocked setTimeout, so wait for those to
	// settle instead of enabling t.mock.timers.
	const { q, flushed } = make({
		maxBatch: 2,
		idleMs: 100_000,
		maxWaitMs: 100_000,
	});
	q.addMany(["a", "b", "c", "d"]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(flushed, [
		["a", "b"],
		["c", "d"],
	]);
});

test("addMany below the cap arms the idle timer like add()", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { q, flushed } = make({ idleMs: 100, maxBatch: 99 });
	q.addMany(["a", "b"]);
	assert.equal(flushed.length, 0);
	t.mock.timers.tick(100);
	assert.deepEqual(flushed, [["a", "b"]]);
});

test("addMany with an empty array is a no-op", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { q, flushed } = make();
	q.addMany([]);
	assert.equal(q.depth, 0);
	t.mock.timers.tick(1000);
	assert.equal(flushed.length, 0);
});

test("addMany doesn't blow the call stack on a very large batch", (t) => {
	// push(...ids) would spread every element as an individual argument — fine normally,
	// but a RangeError for a batch this size (a wide /reprocess date range). Regression
	// guard for that; the cap-triggered flush chain isn't what's under test here.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { q } = make({ maxBatch: 1_000_000 });
	const huge = Array.from({ length: 200_000 }, (_, i) => String(i));
	assert.doesNotThrow(() => q.addMany(huge));
	assert.equal(q.depth, 200_000);
});
