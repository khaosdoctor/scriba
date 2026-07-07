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
