import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completeTaskLine,
  insertTaskLine,
  parseTaskLine,
  parseTasks,
  renderTaskLine,
  replaceTaskLineAt,
  uncompleteTaskLine,
} from "./line.ts";

const WORK_TAG = "#type/todo/work";
const TAG = "#type/todo";

// Real lines out of the vault's two task notes: the parser has to survive exactly these.
const NOTE = [
  "# Todos",
  "",
  "## Daily agenda",
  "- [ ] not a task, wrong section #type/todo [due:: 2026-09-09]",
  "",
  "## Things to do",
  "- [ ] Buy cat sand (from [[2026-08-29]]) #type/todo [start:: 2026-08-30] [due:: 2026-09-02]",
  "- [x] finish the book #type/todo [start:: 2026-06-15] [due:: 2026-06-14] [completion:: 2026-06-23]",
  "- [-] _[[2026-03-03]] ::_ Hire the cleaning company for a deep clean #type/todo [start:: 2026-03-03] [due:: 2026-03-06] [cancelled:: 2026-03-03]",
  "- [x] _[[2026-03-01]] ::_ Hire insurance from hedvig #type/todo [start:: 2026-02-28] [due:: 2026-02-28] ✅ 2026-03-01",
  "- [x] _[[2026-03-01]] ::_ Export my credit card purchases #type/todo [start::6-03-01] [due:: 2026-03-01] ✅ 2026-03-02",
  "some prose, not a bullet",
  "- [ ] Get a DIY Guitar from [here](https://www.gear4music.se/en/Electric-Guitars/DIY-Guitars) #type/todo [due:: 2026-09-05]",
  "",
  "## Another section",
  "- [ ] also out of scope #type/todo",
].join("\n");

test("parseTasks reads only its own section, in order", () => {
  const tasks = parseTasks(NOTE, "Things to do", TAG, "personal");
  assert.equal(tasks.length, 6);
  assert.deepEqual(
    tasks.map((task) => task.state),
    ["open", "done", "cancelled", "done", "done", "open"],
  );
  assert.deepEqual(
    tasks.map((task) => task.index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(tasks[0]!.text, "Buy cat sand (from [[2026-08-29]])");
  assert.equal(tasks[0]!.start, "2026-08-30");
  assert.equal(tasks[0]!.due, "2026-09-02");
  assert.equal(tasks[0]!.type, "personal");
});

test("parseTasks keeps wikilinks and markdown links in the description", () => {
  const tasks = parseTasks(NOTE, "Things to do", TAG, "personal");
  assert.equal(
    tasks[5]!.text,
    "Get a DIY Guitar from [here](https://www.gear4music.se/en/Electric-Guitars/DIY-Guitars)",
  );
  assert.equal(tasks[2]!.text.startsWith("_[[2026-03-03]] ::_ Hire"), true);
});

test("a completion is read from either notation, and a typo'd date is no date", () => {
  const tasks = parseTasks(NOTE, "Things to do", TAG, "personal");
  assert.equal(tasks[1]!.completion, "2026-06-23"); // [completion:: …]
  assert.equal(tasks[3]!.completion, "2026-03-01"); // legacy ✅
  assert.equal(tasks[4]!.start, null); // [start::6-03-01] is unusable
  assert.equal(tasks[4]!.due, "2026-03-01");
});

test("the work tag doesn't swallow the personal one, and vice versa", () => {
  const work =
    "- [x] Review imagescaler docker #type/todo/work [start:: 2026-07-09] [due:: 2026-07-09] [completion:: 2026-07-09]";
  const asWork = parseTaskLine(work, 0, "work", WORK_TAG)!;
  assert.equal(asWork.text, "Review imagescaler docker");
  // Parsed with the personal tag, the "/work" suffix is left behind rather than half-cut.
  assert.equal(
    parseTaskLine(work, 0, "personal", TAG)!.text,
    "Review imagescaler docker #type/todo/work",
  );
});

test("an empty description and extra fields survive parsing", () => {
  const task = parseTaskLine(
    "- [x] #type/todo/work [id:: ylpq51] [start:: 2026-03-04] [due:: 2026-03-04] [completion:: 2026-06-23]",
    0,
    "work",
    WORK_TAG,
  )!;
  assert.equal(task.text, "");
  assert.equal(task.completion, "2026-06-23");
  assert.equal(parseTaskLine("just prose", 0, "work", WORK_TAG), null);
});

test("a task with no start date starts on its deadline", () => {
  assert.equal(
    renderTaskLine(
      {
        description: "Buy cat sand",
        type: "personal",
        start: null,
        due: "2026-09-02",
      },
      TAG,
      "2026-08-29",
    ),
    "- [ ] Buy cat sand (from [[2026-08-29]]) #type/todo [start:: 2026-09-02] [due:: 2026-09-02]",
  );
  assert.equal(
    renderTaskLine(
      {
        description: "Review the RFC",
        type: "work",
        start: "2026-09-01",
        due: "2026-09-05",
      },
      WORK_TAG,
      "2026-08-29",
    ),
    "- [ ] Review the RFC (from [[2026-08-29]]) #type/todo/work [start:: 2026-09-01] [due:: 2026-09-05]",
  );
});

test("a rendered line parses back to the draft it came from", () => {
  const draft = {
    description: "Buy cat sand",
    type: "personal" as const,
    start: "2026-08-30",
    due: "2026-09-02",
  };
  const back = parseTaskLine(
    renderTaskLine(draft, TAG, "2026-08-29"),
    0,
    "personal",
    TAG,
  )!;
  assert.equal(back.start, draft.start);
  assert.equal(back.due, draft.due);
  assert.equal(back.state, "open");
  assert.equal(back.text, "Buy cat sand (from [[2026-08-29]])");
});

test("completeTaskLine ticks and stamps once; uncomplete undoes both notations", () => {
  const open =
    "- [ ] Buy cat sand #type/todo [start:: 2026-08-30] [due:: 2026-09-02]";
  const done = completeTaskLine(open, "2026-08-31");
  assert.equal(
    done,
    "- [x] Buy cat sand #type/todo [start:: 2026-08-30] [due:: 2026-09-02] [completion:: 2026-08-31]",
  );
  assert.equal(completeTaskLine(done, "2026-09-05"), done); // idempotent
  assert.equal(uncompleteTaskLine(done), open);
  // The legacy ✅ marker is cleaned up the same way.
  assert.equal(
    uncompleteTaskLine(
      "- [x] Hire insurance #type/todo [due:: 2026-02-28] ✅ 2026-03-01",
    ),
    "- [ ] Hire insurance #type/todo [due:: 2026-02-28]",
  );
  assert.equal(uncompleteTaskLine(open), open); // idempotent
});

test("completing a cancelled task drops its cancellation", () => {
  const done = completeTaskLine(
    "- [-] Hire the cleaning company #type/todo [due:: 2026-03-06] [cancelled:: 2026-03-03]",
    "2026-03-09",
  );
  assert.equal(
    done,
    "- [x] Hire the cleaning company #type/todo [due:: 2026-03-06] [completion:: 2026-03-09]",
  );
});

test("insertTaskLine respects each note's own order", () => {
  const note = [
    "## Things to do",
    "- [ ] one",
    "- [ ] two",
    "",
    "## Next",
  ].join("\n");
  assert.match(
    insertTaskLine(note, "Things to do", "- [ ] new", "bottom"),
    /- \[ \] two\n- \[ \] new/,
  );
  assert.match(
    insertTaskLine(note, "Things to do", "- [ ] new", "top"),
    /## Things to do\n- \[ \] new\n- \[ \] one/,
  );
  assert.match(
    insertTaskLine(
      "## Other Tasks\n\n## Next",
      "Other Tasks",
      "- [ ] new",
      "top",
    ),
    /## Other Tasks\n\n- \[ \] new/,
  );
  assert.throws(
    () => insertTaskLine(note, "Nowhere", "- [ ] new", "top"),
    /Nowhere/,
  );
});

test("replaceTaskLineAt counts only checklist rows, so prose inside the section cannot shift a tap", () => {
  const out = replaceTaskLineAt(
    NOTE,
    "Things to do",
    5,
    "- [x] Get a DIY Guitar #type/todo",
  );
  assert.match(
    out!,
    /some prose, not a bullet\n- \[x\] Get a DIY Guitar #type\/todo\n/,
  );
  assert.equal(out!.split("\n").length, NOTE.split("\n").length);
});
