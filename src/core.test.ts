import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_UPDATE_CHARS,
  clipUpdate,
  doneMessage,
  editConfirmation,
  feedMessage,
  fitFeed,
  followupQuestions,
  followupRef,
  formatJotDetail,
  formatToolCall,
  gaveUpMessage,
  jotPreview,
  monthGrid,
  parseEntrySize,
  parseFollowupRef,
  parseWizardRef,
  previewList,
  queuedNotice,
  ratingDay,
  retryNotice,
  TELEGRAM_LIMIT,
  thoughtIcon,
  toolIcon,
  WIZARD_ENTRYSIZE_REF,
  WIZARD_NOTE_REF,
  WIZARD_RATING_TIME_REF,
  WIZARD_REGISTER_REF,
  WIZARD_STOPWORD_REF,
} from "./core.ts";
import { parseHabitRef } from "./flows/habits/parse.ts";
import type { Jot } from "./models/domain.ts";

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
const HEADINGS = { journal: "Journal", til: "TIL" };

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

test("followupRef round-trips through parseFollowupRef", () => {
  for (const q of ["journal", "til"] as const) {
    const text = `Learned anything today? Reply to this message.\n${followupRef(q, "2026-07-05")}`;
    assert.deepEqual(parseFollowupRef(text), {
      question: q,
      date: "2026-07-05",
    });
  }
  assert.equal(parseFollowupRef("(fu:x:2026-07-05)"), null);
  assert.equal(parseFollowupRef("(hb:2026-07-05:1)"), null);
});

test("doneMessage marks which piece a split jot is", () => {
  const one = doneMessage("10:00:00", "text", "hi", "a1b2c3d4");
  assert.ok(!one.includes("part"));
  const piece = doneMessage("10:00:00", "text", "hi", "a1b2c3d4", 0, {
    i: 2,
    of: 3,
  });
  assert.ok(piece.includes("✂️ part 2 of 3"));
});

test("parseEntrySize validates a typed entry size", () => {
  assert.equal(parseEntrySize("280"), 280);
  assert.equal(parseEntrySize(" off "), 0);
  assert.equal(parseEntrySize("0"), 0);
  assert.equal(parseEntrySize("10"), null); // no sentence fits
  assert.equal(parseEntrySize("99999"), null);
  assert.equal(parseEntrySize("lots"), null);
});

test("doneMessage blockquotes the time and escapes content", () => {
  assert.equal(
    doneMessage("14:32:00", "text", "ran <5k> today", "a1b2c3d4"),
    "✅ Saved to your journal\n<blockquote>🕒 14:32:00 · ran &lt;5k&gt; today</blockquote>\n🔖 <code>a1b2c3d4</code>",
  );
});

test("doneMessage notes a squash only when more than one jot merged", () => {
  // 0/1 = no merge, no extra line; 2+ appends the squash count.
  assert.ok(!doneMessage("14:32:00", "text", "x", "a1b2c3d4").includes("🧵"));
  assert.ok(
    !doneMessage("14:32:00", "text", "x", "a1b2c3d4", 1).includes("🧵"),
  );
  assert.match(
    doneMessage("14:32:00", "text", "x", "a1b2c3d4", 3),
    /🧵 3 jots squashed into one entry$/,
  );
});

test("editConfirmation blockquotes the time and escapes content", () => {
  assert.equal(
    editConfirmation("14:32:00", "ran <5k> today"),
    "✏️ Updated\n<blockquote>🕒 14:32:00 · ran &lt;5k&gt; today</blockquote>",
  );
});

test("editConfirmation falls back to an ellipsis for a blank result (e.g. a delete)", () => {
  assert.equal(
    editConfirmation("14:32:00", "   "),
    "✏️ Updated\n<blockquote>🕒 14:32:00 · …</blockquote>",
  );
});

test("formatJotDetail shows full text and includes errors", () => {
  const jot: Jot = {
    id: "deadbeef",
    kind: "audio",
    note_path: "notes/x.md",
    anchor: "deadbeef",
    time: "10:00:00",
    raw_text: null,
    transcript: "x".repeat(400),
    proposed_text: null,
    section: "journal",
    asset_path: null,
    file_id: null,
    status: "failed",
    attempts: 3,
    error: "boom",
    received_at: Date.now(),
    updated_at: Date.now(),
  };
  const out = formatJotDetail(jot);
  assert.match(out, /deadbeef \[audio\] — failed/);
  assert.match(out, /Attempts: 3/);
  assert.match(out, /Error: boom/);
  assert.ok(out.includes(`Text: ${"x".repeat(400)}`)); // transcript shown in full
});

test("parseWizardRef tells the wizard's prompts apart", () => {
  assert.deepEqual(parseWizardRef(`add words ${WIZARD_STOPWORD_REF}`), {
    kind: "sw",
  });
  assert.deepEqual(parseWizardRef(`add pairs ${WIZARD_REGISTER_REF}`), {
    kind: "rg",
  });
  // `rg` is a prefix of `rgn`/`rgw` — the longer refs must not be read as a bare `rg`
  assert.deepEqual(parseWizardRef(`search ${WIZARD_NOTE_REF}`), {
    kind: "rgn",
  });
  assert.deepEqual(parseWizardRef("rename it (lw:rgw:12)"), {
    kind: "rgw",
    index: 12,
  });
  assert.deepEqual(parseWizardRef(`how long? ${WIZARD_ENTRYSIZE_REF}`), {
    kind: "es",
  });
  assert.equal(parseWizardRef("rename it (lw:rgw)"), null); // index is required
  assert.equal(parseWizardRef("Rate Exercise (hb:2026-07-29:0)"), null);
  assert.equal(parseWizardRef(""), null);
});

test("parseWizardRef recognises the rating-time prompt", () => {
  assert.deepEqual(parseWizardRef(`when? ${WIZARD_RATING_TIME_REF}`), {
    kind: "rt",
  });
});

test("ratingDay reads an unpadded hour", () => {
  const now = new Date(2026, 6, 6, 12, 0).getTime();
  assert.equal(ratingDay("9:30", now), "2026-07-05");
});

test("followupQuestions counts a missing section as empty", () => {
  assert.deepEqual(
    followupQuestions("## Journal\n- a\n", { journal: "Journal", til: "TIL" }),
    ["til"],
  );
  assert.deepEqual(
    followupQuestions("## TIL\n- a\n", { journal: "Journal", til: "TIL" }),
    ["journal"],
  );
  assert.deepEqual(
    followupQuestions("# 2026-07-05\n", { journal: "Journal", til: "TIL" }),
    ["journal", "til"],
  );
});

test("a follow-up marker is not read by the other flows' parsers, nor theirs by it", () => {
  const prompt = `question ${followupRef("journal", "2026-07-05")}`;
  assert.equal(parseHabitRef(prompt), null);
  assert.equal(parseWizardRef(prompt), null);
  for (const other of [
    "(hb:2026-07-05:1)",
    "(rt:time)",
    "(lw:sw)",
    "(tk:d:abcdef12)",
  ])
    assert.equal(parseFollowupRef(other), null, other);
});

test("jotPreview falls back to (kind) for a captionless attach-only jot", () => {
  const base = {
    id: "aaaaaaaa",
    kind: "image" as const,
    note_path: "x.md",
    anchor: "aaaaaaaa",
    time: "10:00:00",
    raw_text: null,
    transcript: null,
    proposed_text: null,
    section: "journal" as const,
    asset_path: null,
    file_id: null,
    status: "done" as const,
    attempts: 0,
    error: null,
    received_at: 0,
    updated_at: 0,
  };
  assert.equal(jotPreview(base), "(image)");
  assert.equal(
    jotPreview({ ...base, raw_text: "a  sunset\nphoto" }),
    "a sunset photo",
  );
  assert.equal(
    jotPreview({ ...base, kind: "audio", transcript: "hello there" }, 5),
    "hello",
  );
});

test("monthGrid pads a month to full weeks starting Sunday", () => {
  // July 2026 starts on a Wednesday and has 31 days.
  const grid = monthGrid(2026, 7);
  assert.equal(grid[0]!.filter((d) => d === 0).length, 3); // Sun/Mon/Tue padding
  assert.equal(grid[0]![3], 1); // Wed 1st
  const flat = grid.flat().filter((d) => d !== 0);
  assert.deepEqual(
    flat,
    Array.from({ length: 31 }, (_, i) => i + 1),
  );
  for (const week of grid) assert.equal(week.length, 7);
});

test("retryNotice says where in the retry cycle a jot is", () => {
  const out = retryNotice("audio", 2, 10, "fetch failed");
  assert.match(out, /That audio jot didn't go through \(attempt 2 of 10\)/);
  assert.match(out, /8 more tries left/);
  assert.match(out, /<code>fetch failed<\/code>/);
  // The last try before giving up reads as one, not "1 more tries".
  assert.match(retryNotice("text", 9, 10, "boom"), /one more try left/);
});

test("gaveUpMessage names the reason and the burst it covers", () => {
  const out = gaveUpMessage("text", "unrecoverable error", "bad json");
  assert.match(out, /Gave up on a text jot \(unrecoverable error\)/);
  assert.match(out, /Posted it un-enriched/);
  assert.ok(!out.includes("squashed"));
  assert.match(
    gaveUpMessage("audio", "no luck after 10 tries", "boom", 3),
    /🧵 3 jots squashed into one entry/,
  );
});

test("a failure message escapes and caps the error it quotes", () => {
  // An error is arbitrary text: it must not be able to inject markup…
  assert.match(
    retryNotice("text", 1, 10, "<b>nope</b> & co"),
    /&lt;b&gt;nope&lt;\/b&gt; &amp; co/,
  );
  // …nor push the message past Telegram's limit with a whole stack trace.
  const huge = gaveUpMessage("text", "unrecoverable error", "x".repeat(5000));
  assert.ok(huge.length < TELEGRAM_LIMIT);
  assert.match(huge, /x…<\/code>/);
  assert.match(retryNotice("text", 1, 10, "   "), /no error message/);
});

test("feedMessage puts the tail under the header", () => {
  assert.equal(feedMessage("🧭 Working…", []), "🧭 Working…");
  assert.equal(
    feedMessage("🧭 Working…", ["📖 read a.md", "✍️ wrote b.md"]),
    "🧭 Working…\n\n📖 read a.md\n✍️ wrote b.md",
  );
});

test("fitFeed drops the oldest lines until the message fits", () => {
  const lines = Array.from(
    { length: 20 },
    (_, i) => `line ${i} ${"x".repeat(300)}`,
  );
  const kept = fitFeed("head", lines);
  assert.ok(feedMessage("head", kept).length <= TELEGRAM_LIMIT);
  // The newest survive, the oldest are the ones that go.
  assert.equal(kept.at(-1), lines.at(-1));
  assert.ok(!kept.includes(lines[0]!));
  // Nothing to drop when it already fits.
  assert.deepEqual(fitFeed("head", ["a", "b"]), ["a", "b"]);
  assert.deepEqual(fitFeed("head", []), []);
  // One line over the limit is still shown — something has to be on screen.
  assert.equal(fitFeed("head", ["y".repeat(5000)]).length, 1);
});

test("toolIcon says which tool without the mcp prefix", () => {
  assert.equal(toolIcon("mcp__vault__vault_read"), "📖");
  assert.equal(toolIcon("mcp__vault__vault_write"), "✍️");
  assert.equal(toolIcon("mcp__vault__vault_delete"), "🗑");
  assert.equal(toolIcon("WebSearch"), "🔎");
  // An unknown tool still gets a line, just a generic one.
  assert.equal(toolIcon("mcp__vault__something_new"), "🔧");
});

test("thoughtIcon reflects what the line is about", () => {
  assert.equal(thoughtIcon("searching for the meeting note"), "🔍");
  assert.equal(thoughtIcon("Reading notes/a.md first"), "📖");
  assert.equal(thoughtIcon("writing the note now"), "✍️");
  assert.equal(thoughtIcon("deleting the stale one"), "🗑");
  assert.equal(thoughtIcon("fetching the page"), "🌐");
  assert.equal(thoughtIcon("that failed, trying again"), "⚠️");
  assert.equal(thoughtIcon("matching the vault's voice"), "🎨");
  // Nothing recognisable is still a thought.
  assert.equal(thoughtIcon("hmm"), "💭");
  assert.equal(thoughtIcon(""), "💭");
});

test("clipUpdate flattens to one line and caps the length", () => {
  assert.equal(clipUpdate("  one\n\ttwo   three "), "one two three");
  const long = `${"word ".repeat(200)}end`;
  const out = clipUpdate(long);
  assert.ok(out.length <= AGENT_UPDATE_CHARS);
  // The cut lands on a word boundary, so the last word isn't left half-written.
  assert.match(out, /^(word )+word…$/);
  // A single unbroken run still gets cut, boundary or not.
  assert.equal(clipUpdate("x".repeat(500)).length, AGENT_UPDATE_CHARS);
  assert.equal(clipUpdate("short", 10), "short");
});

test("formatToolCall names the tool and what it is acting on", () => {
  assert.equal(
    formatToolCall("mcp__vault__vault_read", { path: "notes/a.md" }),
    "vault_read · notes/a.md",
  );
  assert.equal(
    formatToolCall("mcp__vault__vault_search", { query: "kubernetes" }),
    "vault_search · kubernetes",
  );
  // A write carries the whole note; its size is the useful part, never the body.
  assert.equal(
    formatToolCall("mcp__vault__vault_write", {
      path: "notes/a.md",
      content: "hello",
    }),
    "vault_write · notes/a.md (5 chars)",
  );
  assert.equal(
    formatToolCall("WebSearch", { query: "scriba" }),
    "WebSearch · scriba",
  );
  assert.equal(formatToolCall("mcp__vault__vault_list", {}), "vault_list");
  // A server name with an underscore in it still loses only the prefix.
  assert.equal(formatToolCall("mcp__my_server__do_it", {}), "do_it");
});

test("queuedNotice says how many are ahead", () => {
  assert.match(queuedNotice(1), /1 message ahead/);
  assert.match(queuedNotice(3), /3 messages ahead/);
});

test("previewList counts what it leaves out instead of cutting silently", () => {
  assert.equal(previewList(["a", "b"], 5), "a, b");
  assert.equal(previewList([], 5), "");
  assert.equal(previewList(["a", "b", "c", "d"], 2), "a, b … +2 more");
});
