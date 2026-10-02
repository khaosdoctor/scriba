import assert from "node:assert/strict";
import { test } from "node:test";
import { followupQuestions, RatingSchema } from "./entity.ts";

const HEADINGS = { journal: "Journal", til: "TIL" };

const DAILY_TEMPLATE = `---
tags:
  - type/daily-note
overallRating: 5
---
# 2026-07-05
---
## ✅ Tasks
\`\`\`tasks
preset on_or_before_this_file_name
\`\`\`
## Journal
-
## Habits
- [ ] Practiced music #meta/habits/music
## TIL
-
## Log
- [Health log](obsidian://open)
`;

test("RatingSchema takes button text for a whole number from 1 to 10", () => {
  for (const ok of ["1", "7", "10"])
    assert.equal(RatingSchema.safeParse(ok).success, true, ok);
  for (const bad of ["0", "11", "5.5", "", "x", " ", "-1", "Infinity"])
    assert.equal(RatingSchema.safeParse(bad).success, false, bad);
  assert.equal(RatingSchema.safeParse(undefined).success, false);
});

test("followupQuestions asks only what is still empty", () => {
  const jot = "- _10:00:00 ::_ hi ^aaaaaaaa";
  const til = "- a thing I learned";
  const withJournal = DAILY_TEMPLATE.replace(
    "## Journal\n-\n",
    `## Journal\n${jot}\n`,
  );
  const withTil = DAILY_TEMPLATE.replace("## TIL\n-\n", `## TIL\n${til}\n`);
  const withBoth = withJournal.replace("## TIL\n-\n", `## TIL\n${til}\n`);
  assert.deepEqual(followupQuestions(DAILY_TEMPLATE, HEADINGS), [
    "journal",
    "til",
  ]);
  assert.deepEqual(followupQuestions(withJournal, HEADINGS), ["til"]);
  assert.deepEqual(followupQuestions(withTil, HEADINGS), ["journal"]);
  assert.deepEqual(followupQuestions(withBoth, HEADINGS), []);
});

test("followupQuestions asks both for a day with no note, and resumes after a question", () => {
  assert.deepEqual(followupQuestions(null, HEADINGS), ["journal", "til"]);
  assert.deepEqual(followupQuestions(null, HEADINGS, "journal"), ["til"]);
  assert.deepEqual(followupQuestions(null, HEADINGS, "til"), []);
});

test("followupQuestions follows the configured headings", () => {
  const note = "## Journal\n- \n## Learned\n- something\n";
  assert.deepEqual(
    followupQuestions(note, { journal: "Journal", til: "Learned" }),
    ["journal"],
  );
});

test("followupQuestions counts a missing section as empty", () => {
  assert.deepEqual(followupQuestions("## Journal\n- a\n", HEADINGS), ["til"]);
  assert.deepEqual(followupQuestions("## TIL\n- a\n", HEADINGS), ["journal"]);
  assert.deepEqual(followupQuestions("# 2026-07-05\n", HEADINGS), [
    "journal",
    "til",
  ]);
});
