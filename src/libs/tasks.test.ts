import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleTask as task } from "../test/fakes.ts";
import {
  parseTaskRef,
  taskButtonLabel,
  taskCard,
  taskListLine,
  taskRef,
} from "./tasks.ts";

const TODAY = "2026-08-29"; // a Saturday

test("a prompt is recognized by its marker, and an ordinary message is not", () => {
  assert.equal(taskRef("u", "d1d1d1d1"), "(tk:u:d1d1d1d1)");
  assert.deepEqual(parseTaskRef(`due? ${taskRef("u", "d1d1d1d1")}`), {
    field: "u",
    id: "d1d1d1d1",
  });
  assert.deepEqual(parseTaskRef("(tk:d:0123456789abcdef)"), {
    field: "d",
    id: "0123456789abcdef",
  });
  assert.deepEqual(parseTaskRef("the task. (tk:add)"), { field: "add" });
  assert.equal(parseTaskRef("(tk:u:xyz)"), null);
  assert.equal(parseTaskRef("just a message"), null);
});

test("a row shows the dates a task carries and says when it has no text", () => {
  assert.equal(
    taskListLine(
      task({ text: "", due: "2026-09-02", start: "2026-08-30" }),
      1,
      TODAY,
    ),
    "1. ☐ (no description) · due 2026-09-02 · starts 2026-08-30 <i>personal</i>",
  );
  assert.equal(
    taskListLine(task({ text: "no dates" }), 2, TODAY),
    "2. ☐ no dates <i>personal</i>",
  );
  assert.equal(
    taskListLine(task({ text: "ticked by hand", state: "done" }), 3, TODAY),
    "3. ☑ ticked by hand <i>personal</i>",
  );
  assert.equal(
    taskListLine(task({ text: "x".repeat(200) }), 4, TODAY),
    `4. ☐ ${"x".repeat(159)}… <i>personal</i>`,
  );
  assert.equal(taskButtonLabel(task({ text: "" }), 5), "☐ 5. (no description)");
  assert.match(
    taskCard({
      description: "",
      type: "personal",
      start: null,
      due: "2026-09-02",
    }),
    /\(no description yet\)/,
  );
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
