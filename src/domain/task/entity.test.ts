import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleTask as task } from "../../test/fakes.ts";
import { effectiveStart, filterTasks } from "./entity.ts";

const TODAY = "2026-08-29"; // a Saturday

test("the list presets mirror the vault's task queries", () => {
  const tasks = [
    task({ index: 0, due: "2026-08-20", text: "overdue" }),
    task({ index: 1, due: "2026-08-29", text: "today" }),
    task({ index: 2, due: "2026-09-02", text: "this week-ish" }),
    task({ index: 3, due: "2026-10-30", text: "far off" }),
    task({
      index: 4,
      state: "done",
      completion: "2026-08-01",
      text: "old done",
    }),
    task({
      index: 5,
      state: "done",
      completion: "2026-08-28",
      text: "new done",
    }),
    task({
      index: 6,
      state: "cancelled",
      due: "2026-08-29",
      text: "cancelled",
    }),
    task({
      index: 7,
      start: "2026-08-29",
      due: "2026-11-01",
      text: "starts today",
    }),
  ];
  const texts = (view: Parameters<typeof filterTasks>[1]) =>
    filterTasks(tasks, view, TODAY).map((row) => row.text);
  assert.deepEqual(texts("open"), [
    "overdue",
    "today",
    "this week-ish",
    "far off",
    "starts today",
  ]);
  assert.deepEqual(texts("overdue"), ["overdue"]);
  // The morning summary's view: due today, still due from before, or starting today.
  assert.deepEqual(texts("day"), ["overdue", "today", "starts today"]);
  assert.deepEqual(texts("today"), ["today", "starts today"]);
  assert.deepEqual(texts("future"), [
    "today",
    "this week-ish",
    "far off",
    "starts today",
  ]);
  assert.deepEqual(texts("two"), ["today", "this week-ish"]);
  assert.deepEqual(texts("done"), ["new done", "old done"]); // newest completion first
  // "this week" is Sun 23rd–Sat 29th: the overdue one is out, a task starting today is in.
  assert.deepEqual(texts("week"), ["today", "starts today"]);
});

test("effectiveStart falls back to the deadline", () => {
  assert.equal(effectiveStart(task({ due: "2026-09-02" })), "2026-09-02");
  assert.equal(
    effectiveStart(task({ start: "2026-08-30", due: "2026-09-02" })),
    "2026-08-30",
  );
});

test("open tasks sort by deadline, then start, then text, with undated ones last", () => {
  const tasks = [
    task({ text: "no deadline" }),
    task({ text: "b same day", due: "2026-09-02" }),
    task({ text: "also no deadline" }),
    task({ text: "a same day", due: "2026-09-02" }),
    task({ text: "earlier start", start: "2026-08-30", due: "2026-09-02" }),
  ];
  assert.deepEqual(
    filterTasks(tasks, "open", TODAY).map((row) => row.text),
    [
      "earlier start",
      "a same day",
      "b same day",
      "also no deadline",
      "no deadline",
    ],
  );
});

test("done tasks list the newest completion first and hand-ticked ones without a date last", () => {
  const tasks = [
    task({ text: "undated", state: "done" }),
    task({ text: "older", state: "done", completion: "2026-08-01" }),
    task({ text: "newer", state: "done", completion: "2026-08-28" }),
  ];
  assert.deepEqual(
    filterTasks(tasks, "done", TODAY).map((row) => row.text),
    ["newer", "older", "undated"],
  );
});
