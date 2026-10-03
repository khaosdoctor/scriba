import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorLine,
  deleteAnchorLine,
  findSection,
  frontmatterBlock,
  insertJournalLine,
  moveAnchorLine,
  replaceAnchorLine,
  sectionHasContent,
  setFrontmatterValue,
  stampCompletion,
} from "./note.ts";

test("frontmatterBlock returns the text between the leading fences", () => {
  assert.equal(frontmatterBlock("---\nrating: 5\n---\nbody"), "rating: 5");
  assert.equal(frontmatterBlock("body\n---\nrating: 5\n---"), undefined);
});

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

test("findSection returns the heading and the next heading of any level, or the note end", () => {
  const lines = DAILY_TEMPLATE.split("\n");
  const habits = findSection(lines, "Habits");
  assert.equal(lines[habits!.headingIdx], "## Habits");
  assert.equal(lines[habits!.end], "## TIL");
  const log = findSection(lines, "Log");
  assert.equal(log!.end, lines.length);
  assert.equal(findSection(lines, "Nope"), null);
  assert.equal(findSection(["Habits", "- x"], "Habits"), null);
});

test("stampCompletion appends the stamp once and leaves a stamped line as it is", () => {
  assert.equal(
    stampCompletion("- [x] Run #t  ", "2026-07-05"),
    "- [x] Run #t [completion:: 2026-07-05]",
  );
  const stamped = "- [x] Run [Completion :: 2026-01-01]";
  assert.equal(stampCompletion(stamped, "2026-07-05"), stamped);
});

test("sectionHasContent ignores the template's empty heading and placeholder bullet", () => {
  assert.equal(sectionHasContent(DAILY_TEMPLATE, "Journal"), false);
  assert.equal(sectionHasContent(DAILY_TEMPLATE, "TIL"), false);
  assert.equal(sectionHasContent("## TIL\n", "TIL"), false);
  assert.equal(sectionHasContent("## TIL\n- [ ]\n* \n\n---\n", "TIL"), false);
});

test("sectionHasContent counts a jot, a placeholder line or plain text", () => {
  const jot = DAILY_TEMPLATE.replace(
    "## Journal\n-\n",
    "## Journal\n- _10:00:00 ::_ hi ^aaaaaaaa\n",
  );
  assert.equal(sectionHasContent(jot, "Journal"), true);
  assert.equal(sectionHasContent(jot, "TIL"), false);
  assert.equal(sectionHasContent("## TIL\n- _1:00 ::_ ⏳ ^a\n", "TIL"), true);
  assert.equal(sectionHasContent("## TIL\nsomething\n", "TIL"), true);
});

test("sectionHasContent stops at the next heading and treats a missing heading as empty", () => {
  assert.equal(
    sectionHasContent("## Journal\n- \n## TIL\n- x\n", "Journal"),
    false,
  );
  assert.equal(sectionHasContent("## Journal\n- x\n", "TIL"), false);
});

test("sectionHasContent does not read the rating out of frontmatter", () => {
  assert.equal(
    sectionHasContent("---\noverallRating: 5\n---\n## TIL\n- \n", "TIL"),
    false,
  );
});

test("setFrontmatterValue replaces an existing field in place", () => {
  const note = "---\noverallRating: 5\ntags: [daily]\n---\n\n## Journal\n";
  assert.equal(
    setFrontmatterValue(note, "overallRating", 8),
    "---\noverallRating: 8\ntags: [daily]\n---\n\n## Journal\n",
  );
});

test("setFrontmatterValue inserts a missing field before the closing fence", () => {
  const note = "---\ntags: [daily]\n---\n\nbody\n";
  assert.equal(
    setFrontmatterValue(note, "overallRating", 7),
    "---\ntags: [daily]\noverallRating: 7\n---\n\nbody\n",
  );
});

test("setFrontmatterValue writes a string value too (updatedAt on a task note)", () => {
  const note =
    "---\ntitle: Todos\nupdatedAt: 2026-08-01T10:00:00Z\n---\n# Todos\n";
  assert.equal(
    setFrontmatterValue(note, "updatedAt", "2026-08-29T16:10:02Z"),
    "---\ntitle: Todos\nupdatedAt: 2026-08-29T16:10:02Z\n---\n# Todos\n",
  );
});

test("setFrontmatterValue creates frontmatter when the note has none", () => {
  assert.equal(
    setFrontmatterValue("# hi\n", "overallRating", 3),
    "---\noverallRating: 3\n---\n\n# hi\n",
  );
});

test("insertJournalLine replaces the empty template bullet on the first jot", () => {
  const note = "# 2026-07-07\n\n## Journal\n- \n";
  const out = insertJournalLine(
    note,
    "Journal",
    "- _19:56:31 ::_ ⏳ ^23c78f08",
  );
  assert.equal(
    out,
    "# 2026-07-07\n\n## Journal\n- _19:56:31 ::_ ⏳ ^23c78f08\n",
  );
});

test("insertJournalLine appends right after the last bullet, no blank line", () => {
  const note = "## Journal\n- _19:56:31 ::_ first ^aaaaaaaa\n";
  const out = insertJournalLine(
    note,
    "Journal",
    "- _19:57:00 ::_ ⏳ ^bbbbbbbb",
  );
  assert.equal(
    out,
    "## Journal\n- _19:56:31 ::_ first ^aaaaaaaa\n- _19:57:00 ::_ ⏳ ^bbbbbbbb\n",
  );
});

test("insertJournalLine stays within the section, before the next heading", () => {
  const note = "## Journal\n- _10:00:00 ::_ a ^aaaaaaaa\n\n## Notes\n- keep\n";
  const out = insertJournalLine(
    note,
    "Journal",
    "- _10:01:00 ::_ ⏳ ^bbbbbbbb",
  );
  assert.equal(
    out,
    "## Journal\n- _10:00:00 ::_ a ^aaaaaaaa\n- _10:01:00 ::_ ⏳ ^bbbbbbbb\n\n## Notes\n- keep\n",
  );
});

test("insertJournalLine inserts right after the heading when the section is empty", () => {
  const note = "## Journal\n";
  const out = insertJournalLine(
    note,
    "Journal",
    "- _10:00:00 ::_ ⏳ ^aaaaaaaa",
  );
  assert.equal(out, "## Journal\n- _10:00:00 ::_ ⏳ ^aaaaaaaa\n");
});

test("replace/delete/read find the line by anchor and leave others intact", () => {
  const note = [
    "## Journal",
    "- _10:00:00 ::_ first ^aaaaaaaa",
    "- _10:01:00 ::_ ⏳ ^bbbbbbbb",
    "- _10:02:00 ::_ third ^cccccccc",
  ].join("\n");
  const replaced = replaceAnchorLine(
    note,
    "bbbbbbbb",
    "- _10:01:00 ::_ enriched ^bbbbbbbb",
  );
  assert.ok(replaced?.includes("enriched ^bbbbbbbb"));
  assert.ok(replaced?.includes("first ^aaaaaaaa"));
  assert.ok(!replaced?.includes("⏳"));
  assert.equal(replaceAnchorLine(note, "ffffffff", "x"), null);
  assert.equal(anchorLine(note, "cccccccc"), "- _10:02:00 ::_ third ^cccccccc");

  const deleted = deleteAnchorLine(note, "aaaaaaaa");
  assert.ok(!deleted?.includes("aaaaaaaa"));
  assert.ok(deleted?.includes("cccccccc"));
});

test("a split jot writes its own line and its spillover lines in one replace", () => {
  const note = [
    "## Journal",
    "- _10:00:00 ::_ first ^aaaaaaaa",
    "- _10:01:00 ::_ ⏳ ^bbbbbbbb",
    "- _10:02:00 ::_ third ^cccccccc",
  ].join("\n");
  // Each piece is its own jot, so each line carries that jot's own anchor: they go in
  // together so they arrive in order, right where the placeholder was.
  const out = replaceAnchorLine(
    note,
    "bbbbbbbb",
    [
      "- _10:01:00 ::_ piece one ^bbbbbbbb",
      "- _10:01:00 ::_ piece two ^11112222",
    ].join("\n"),
  );
  assert.equal(
    out,
    [
      "## Journal",
      "- _10:00:00 ::_ first ^aaaaaaaa",
      "- _10:01:00 ::_ piece one ^bbbbbbbb",
      "- _10:01:00 ::_ piece two ^11112222",
      "- _10:02:00 ::_ third ^cccccccc",
    ].join("\n"),
  );
  // The spillover line is an ordinary jot line: it deletes on its own.
  const deleted = deleteAnchorLine(out ?? "", "11112222");
  assert.ok(!deleted?.includes("piece two"));
  assert.ok(deleted?.includes("piece one"));
});

test("replaceAnchorLine takes `$&` in the new text literally", () => {
  const note = "- _10:00:00 ::_ ⏳ ^aaaaaaaa";
  assert.equal(
    replaceAnchorLine(note, "aaaaaaaa", "- _10:00:00 ::_ cost $& up ^aaaaaaaa"),
    "- _10:00:00 ::_ cost $& up ^aaaaaaaa",
  );
});

test("sectionHasContent treats every scaffolding shape as empty", () => {
  for (const line of [
    "  - ",
    "+ ",
    "* [x]",
    "- [X]  ",
    "----",
    "<!-- a -->",
    " ",
    "\t",
  ])
    assert.equal(sectionHasContent(`## TIL\n${line}\n`, "TIL"), false, line);
});

test("sectionHasContent reads the last section to the end of the note", () => {
  assert.equal(sectionHasContent("## TIL\n- x", "TIL"), true);
  assert.equal(sectionHasContent("## TIL", "TIL"), false);
});

test("insertJournalLine keeps its paths after the section search was shared", () => {
  assert.equal(insertJournalLine("a\n\n\n", "Journal", "L"), "a\nL\n");
  assert.equal(insertJournalLine("", "Journal", "L"), "\nL\n");
  assert.equal(
    insertJournalLine("# Journal\n- \n", "Journal", "L"),
    "# Journal\nL\n",
  );
  assert.equal(
    insertJournalLine("#### Journal\n- \n", "Journal", "L"),
    "#### Journal\nL\n",
  );
  assert.equal(
    insertJournalLine("## Journal  \n- \n", "Journal", "L"),
    "## Journal  \nL\n",
  );
  assert.equal(
    insertJournalLine("## Journal\n- a\n## Journal\n- b\n", "Journal", "L"),
    "## Journal\n- a\nL\n## Journal\n- b\n",
  );
  assert.equal(
    insertJournalLine("## Journal\r\n- \r\n", "Journal", "L"),
    "## Journal\r\nL\n",
  );
});

test("moveAnchorLine moves the line under the heading and leaves its anchor alone", () => {
  const note = [
    "## Journal",
    "- _10:00:00 ::_ first ^aaaaaaaa",
    "- _10:01:00 ::_ learned a thing ^bbbbbbbb",
    "## Habits",
    "- [ ] Read",
    "## TIL",
    "- ",
    "## Log",
  ].join("\n");
  assert.deepEqual(moveAnchorLine(note, "bbbbbbbb", "TIL"), {
    note: [
      "## Journal",
      "- _10:00:00 ::_ first ^aaaaaaaa",
      "## Habits",
      "- [ ] Read",
      "## TIL",
      "- _10:01:00 ::_ learned a thing ^bbbbbbbb",
      "## Log",
    ].join("\n"),
  });
});

test("moveAnchorLine appends after the TIL bullets already there", () => {
  const note = [
    "## Journal",
    "- _10:01:00 ::_ new ^bbbbbbbb",
    "## TIL",
    "- _09:00:00 ::_ old ^aaaaaaaa",
    "## Log",
  ].join("\n");
  const out = moveAnchorLine(note, "bbbbbbbb", "TIL");
  assert.ok("note" in out);
  assert.equal(
    out.note,
    [
      "## Journal",
      "## TIL",
      "- _09:00:00 ::_ old ^aaaaaaaa",
      "- _10:01:00 ::_ new ^bbbbbbbb",
      "## Log",
    ].join("\n"),
  );
  // Still found by its anchor afterwards, so edit, undo and reprocess keep working.
  assert.equal(
    anchorLine(out.note, "bbbbbbbb"),
    "- _10:01:00 ::_ new ^bbbbbbbb",
  );
});

test("moveAnchorLine says so when the anchor is gone", () => {
  assert.deepEqual(
    moveAnchorLine("## Journal\n- x ^aaaaaaaa\n## TIL", "ffffffff", "TIL"),
    { missing: "line" },
  );
});

test("moveAnchorLine moves the last line of a note that has no trailing newline", () => {
  const note = "## TIL\n- y ^bbbbbbbb\n## Journal\n- x ^aaaaaaaa";
  assert.deepEqual(moveAnchorLine(note, "aaaaaaaa", "TIL"), {
    note: "## TIL\n- y ^bbbbbbbb\n- x ^aaaaaaaa\n## Journal\n",
  });
});

test("moveAnchorLine reorders a line already under the heading and never duplicates it", () => {
  const note = "## TIL\n- a ^aaaaaaaa\n- b ^bbbbbbbb\n## Log";
  const out = moveAnchorLine(note, "aaaaaaaa", "TIL");
  assert.deepEqual(out, {
    note: "## TIL\n- b ^bbbbbbbb\n- a ^aaaaaaaa\n## Log",
  });
});

test("moveAnchorLine moves one indented line and keeps its indent", () => {
  const note = [
    "## Journal",
    "- parent ^pppppppp",
    "  - child one ^aaaaaaaa",
    "  - child two ^cccccccc",
    "## TIL",
    "\t- old ^bbbbbbbb",
  ].join("\n");
  assert.deepEqual(moveAnchorLine(note, "aaaaaaaa", "TIL"), {
    note: [
      "## Journal",
      "- parent ^pppppppp",
      "  - child two ^cccccccc",
      "## TIL",
      "\t- old ^bbbbbbbb",
      "  - child one ^aaaaaaaa",
    ].join("\n"),
  });
});

test("moveAnchorLine touches one line of a realistic note and is idempotent", () => {
  const note = [
    "---",
    "tags:",
    "  - type/daily-note",
    "---",
    "# 2026-08-16",
    "## Habits",
    "- [ ] Read",
    "## Journal",
    "- _10:00:00 ::_ first ^aaaaaaaa",
    "- _10:01:00 ::_ learned x ^bbbbbbbb",
    "## TIL",
    "- ",
    "## Log",
    "- health",
  ].join("\n");
  const first = moveAnchorLine(note, "bbbbbbbb", "TIL");
  assert.ok("note" in first);
  const before = note.split("\n");
  const after = first.note.split("\n");
  assert.deepEqual(
    before.filter((line) => !after.includes(line)),
    ["- "],
  );
  assert.deepEqual(
    after.filter((line) => !before.includes(line)),
    [],
  );
  assert.equal(after.length, before.length - 1);
  assert.deepEqual(moveAnchorLine(first.note, "bbbbbbbb", "TIL"), first);
});

test("moveAnchorLine leaves the source heading bare when the moved line was its only bullet", () => {
  const note = "## Journal\n- only ^aaaaaaaa\n## TIL\n- ";
  assert.deepEqual(moveAnchorLine(note, "aaaaaaaa", "TIL"), {
    note: "## Journal\n## TIL\n- only ^aaaaaaaa",
  });
});

test("moveAnchorLine refuses when the note has no such heading, instead of appending", () => {
  assert.deepEqual(
    moveAnchorLine("## Journal\n- x ^aaaaaaaa", "aaaaaaaa", "TIL"),
    { missing: "heading" },
  );
});
