import assert from "node:assert/strict";
import { test } from "node:test";
import { followupQuestions, RatingSchema, ratingDay } from "./entity.ts";

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

test("ratingDay rolls back across month, year and leap-day boundaries", () => {
  const at = (year: number, month: number, day: number) =>
    new Date(year, month, day, 0, 0).getTime();
  assert.equal(ratingDay("00:00", at(2026, 0, 1)), "2025-12-31");
  assert.equal(ratingDay("00:00", at(2026, 2, 1)), "2026-02-28");
  assert.equal(ratingDay("00:00", at(2028, 2, 1)), "2028-02-29");
  assert.equal(ratingDay("12:00", at(2028, 2, 1)), "2028-03-01");
});

test("ratingDay is a calendar day back on DST change days", () => {
  const saved = process.env.TZ;
  process.env.TZ = "Europe/Stockholm";
  try {
    const spring = new Date(2026, 2, 29, 0, 30).getTime();
    const autumn = new Date(2026, 9, 25, 0, 30).getTime();
    assert.equal(ratingDay("00:00", spring), "2026-03-28");
    assert.equal(ratingDay("00:00", autumn), "2026-10-24");
    assert.equal(ratingDay("22:00", spring), "2026-03-29");
    assert.equal(ratingDay("22:00", autumn), "2026-10-25");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("ratingDay rates yesterday for a just-after-midnight time and today for an evening one", () => {
  const now = new Date(2026, 6, 6, 12, 0, 0).getTime();
  assert.equal(ratingDay("00:00", now), "2026-07-05");
  assert.equal(ratingDay("11:59", now), "2026-07-05");
  assert.equal(ratingDay("12:00", now), "2026-07-06");
  assert.equal(ratingDay("22:30", now), "2026-07-06");
});

test("ratingDay reads an unpadded hour", () => {
  const now = new Date(2026, 6, 6, 12, 0).getTime();
  assert.equal(ratingDay("9:30", now), "2026-07-05");
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
