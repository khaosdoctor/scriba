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
  const queue = new FlushQueue({
    idleMs: 100,
    maxBatch: 3,
    maxWaitMs: 500,
    onFlush: async (ids) => {
      flushed.push(ids);
    },
    ...overrides,
  });
  return { queue, flushed };
}

test("flushes immediately when the batch-size cap is hit", (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, flushed } = make({ maxBatch: 3 });
  queue.add(["a"]);
  queue.add(["b"]);
  assert.equal(flushed.length, 0);
  queue.add(["c"]); // hits cap → synchronous flush
  assert.deepEqual(flushed, [["a", "b", "c"]]);
});

test("flushes after the idle gap", (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, flushed } = make({ idleMs: 100 });
  queue.add(["a"]);
  testContext.mock.timers.tick(99);
  assert.equal(flushed.length, 0);
  testContext.mock.timers.tick(1);
  assert.deepEqual(flushed, [["a"]]);
});

test("idle timer resets on each new message", (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, flushed } = make({ idleMs: 100, maxWaitMs: 10_000 });
  queue.add(["a"]);
  testContext.mock.timers.tick(80);
  queue.add(["b"]); // resets idle
  testContext.mock.timers.tick(80);
  assert.equal(flushed.length, 0); // 80 < 100 since last add
  testContext.mock.timers.tick(20);
  assert.deepEqual(flushed, [["a", "b"]]);
});

test("hard max-wait fires even under a steady trickle", (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, flushed } = make({
    idleMs: 1000,
    maxBatch: 99,
    maxWaitMs: 200,
  });
  queue.add(["a"]);
  testContext.mock.timers.tick(150);
  queue.add(["b"]); // resets idle (1000) but not the max-wait
  testContext.mock.timers.tick(50); // 200 total since first item
  assert.deepEqual(flushed, [["a", "b"]]);
});

test("add(ids) pushes the whole batch and arms once, flushing at the cap", (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, flushed } = make({ maxBatch: 3 });
  queue.add(["a", "b", "c"]); // hits cap in one call → synchronous flush
  assert.deepEqual(flushed, [["a", "b", "c"]]);
});

test("add(ids) chunks a batch larger than maxBatch into multiple flushes", async () => {
  // Real timers here: the cap-triggered flushes chain through arm() -> flush() ->
  // arm() via promise microtasks, not the mocked setTimeout, so wait for those to
  // settle instead of enabling t.mock.timers.
  const { queue, flushed } = make({
    maxBatch: 2,
    idleMs: 100_000,
    maxWaitMs: 100_000,
  });
  queue.add(["a", "b", "c", "d"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(flushed, [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("add(ids) below the cap arms the idle timer", (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, flushed } = make({ idleMs: 100, maxBatch: 99 });
  queue.add(["a", "b"]);
  assert.equal(flushed.length, 0);
  testContext.mock.timers.tick(100);
  assert.deepEqual(flushed, [["a", "b"]]);
});

test("add(ids) with an empty array is a no-op", (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, flushed } = make();
  queue.add([]);
  assert.equal(queue.depth, 0);
  testContext.mock.timers.tick(1000);
  assert.equal(flushed.length, 0);
});

test("add(ids) doesn't blow the call stack on a very large batch", (testContext) => {
  // push(...ids) would spread every element as an individual argument: fine normally,
  // but a RangeError for a batch this size (a wide /reprocess date range). Regression
  // guard for that; the cap-triggered flush chain isn't what's under test here.
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue } = make({ maxBatch: 1_000_000 });
  const huge = Array.from({ length: 200_000 }, (_, index) => String(index));
  assert.doesNotThrow(() => queue.add(huge));
  assert.equal(queue.depth, 200_000);
});

test("a /flush while a batch is draining, or with nothing queued, does nothing", async () => {
  const gate: { open?: () => void } = {};
  const flushed: string[][] = [];
  const queue = new FlushQueue({
    idleMs: 100_000,
    maxBatch: 2,
    maxWaitMs: 100_000,
    onFlush: (ids) =>
      new Promise<void>((resolve) => {
        flushed.push(ids);
        gate.open = resolve;
      }),
  });
  await queue.flush();
  assert.deepEqual(flushed, []);
  queue.add(["a", "b"]);
  await queue.flush();
  assert.deepEqual(flushed, [["a", "b"]]);
  gate.open!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(queue.depth, 0);
});
