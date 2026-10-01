import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../../lib/tasks.ts";
import { taskButtonLabel, taskCard } from "./tasks.ts";

const task = (over: Partial<Task>): Task => ({
  index: 0,
  line: "",
  fingerprint: "0",
  type: "personal",
  state: "open",
  text: "t",
  start: null,
  due: null,
  completion: null,
  ...over,
});

test("the card and the row labels say what's missing", () => {
  const card = taskCard({
    description: "Buy cat sand",
    type: "personal",
    start: null,
    due: null,
  });
  assert.match(card, /Due: — <i>\(needed\)<\/i>/);
  assert.match(card, /🏠 Personal/);
  assert.match(card, /Start: —/); // nothing to start from yet: no deadline either
  // Given only a deadline, that is when it starts.
  assert.match(
    taskCard({
      description: "x",
      type: "work",
      start: null,
      due: "2026-09-02",
    }),
    /Start: 2026-09-02/,
  );
  assert.match(
    taskCard({
      description: "x",
      type: "work",
      start: "2026-09-01",
      due: "2026-09-02",
    }),
    /Start: 2026-09-01/,
  );
  assert.equal(
    taskButtonLabel(task({ text: "a".repeat(50) }), 3, 10),
    `☐ 3. ${"a".repeat(9)}…`,
  );
});
