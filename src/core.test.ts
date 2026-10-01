import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_UPDATE_CHARS,
  clipUpdate,
  doneMessage,
  editConfirmation,
  entitiesToMarkdown,
  feedMessage,
  fitFeed,
  followupQuestions,
  followupRef,
  formatDeployNotice,
  formatHealth,
  formatJotDetail,
  formatListPage,
  formatReleaseList,
  formatReleaseNote,
  formatStats,
  formatStatus,
  formatToolCall,
  gaveUpMessage,
  isInsideRoot,
  jotPreview,
  modelsUrlFor,
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
import type { Stats } from "./models/ops.ts";
import type { ReleaseNote } from "./services/github.ts";

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

test("formatStats hides zero outcome tails", () => {
  const base: Stats = {
    total: 4,
    text: 3,
    audio: 1,
    image: 0,
    video: 0,
    done: 4,
    failed: 0,
    abandoned: 0,
    inflight: 0,
  };
  const clean = formatStats("today", base);
  assert.match(clean, /Jots: 4/);
  assert.match(clean, /voice 1/);
  assert.equal(clean.includes("failed"), false); // no failures → no tail
  const withFail = formatStats("today", { ...base, failed: 2, inflight: 1 });
  assert.match(withFail, /in-flight 1 · failed 2/);
});

function fakeRelease(over: Partial<ReleaseNote> = {}): ReleaseNote {
  return {
    tag: "v1.2.3",
    version: "1.2.3",
    name: "v1.2.3",
    body: "### Bug Fixes\n\n* fixed the thing",
    url: "https://github.com/khaosdoctor/scriba/releases/tag/v1.2.3",
    publishedAt: "2026-07-15T20:03:58Z",
    ...over,
  };
}

test("formatDeployNotice reports version and sha with no release note", () => {
  const out = formatDeployNotice("1.2.3", "abcdef1234", null);
  assert.equal(out, "🚀 scriba deployed — 1.2.3 (abcdef1)");
});

test("formatDeployNotice includes the release body and link when a note is given", () => {
  const out = formatDeployNotice("1.2.3", "abcdef1234", fakeRelease());
  assert.match(out, /scriba deployed — 1\.2\.3 \(abcdef1\)/);
  assert.match(out, /fixed the thing/);
  assert.match(out, /releases\/tag\/v1\.2\.3/);
});

test("formatReleaseNote shows the release name, body, and link", () => {
  const out = formatReleaseNote(
    fakeRelease({ name: "Better fallback errors" }),
  );
  assert.match(out, /📋 Better fallback errors/);
  assert.match(out, /fixed the thing/);
  assert.match(out, /releases\/tag\/v1\.2\.3/);
});

test("formatReleaseNote strips conventional-changelog markdown from the body", () => {
  const body =
    "### Features\n\n" +
    "* add /changelog command and put what's new in the deploy notice ([b95325e](https://github.com/khaosdoctor/scriba/commit/b95325e6721e0e63d502c8642208b9cd0a001a4f))\n\n" +
    "### Bug Fixes\n\n" +
    "* stop asserting usage exhaustion as the cause of enrichment fallback ([#9](https://github.com/khaosdoctor/scriba/issues/9)) ([ff223cd](https://github.com/khaosdoctor/scriba/commit/ff223cdc1092eaa683352258ddb8eb93abc5fd8b))";
  const out = formatReleaseNote(fakeRelease({ body }));
  assert.equal(
    out,
    [
      "📋 v1.2.3",
      [
        "Features:",
        "• add /changelog command and put what's new in the deploy notice",
      ].join("\n"),
      [
        "Bug Fixes:",
        "• stop asserting usage exhaustion as the cause of enrichment fallback",
      ].join("\n"),
      "https://github.com/khaosdoctor/scriba/releases/tag/v1.2.3",
    ].join("\n\n"),
  );
  assert.doesNotMatch(out, /###|\[|\]|\(https/);
});

test("formatReleaseList summarises releases newest-first, and handles an empty list", () => {
  const out = formatReleaseList([
    fakeRelease({ tag: "v1.2.3", publishedAt: "2026-07-15T12:00:00Z" }),
    fakeRelease({ tag: "v1.2.2", publishedAt: "2026-07-10T12:00:00Z" }),
  ]);
  assert.match(out, /• v1\.2\.3 \(2026-07-15\)/);
  assert.match(out, /• v1\.2\.2 \(2026-07-10\)/);
  assert.equal(formatReleaseList([]), "no releases found");
});

test("formatStatus summarises health", () => {
  const out = formatStatus({
    counts: {
      pending: 1,
      processing: 1,
      done: 10,
      failed: 2,
      abandoned: 0,
      deleted: 0,
    },
    queueDepth: 3,
    transcriber: "local",
    links: { enabled: true, files: 5, aliases: 9 },
    version: "1.2.3",
    sha: "abcdef1234",
    uptimeMs: 90_000,
  });
  assert.match(out, /scriba 1\.2\.3 \(abcdef1\)/);
  assert.match(out, /10 done · 2 in-flight · 2 failed/); // pending+processing = in-flight
  assert.match(out, /Queue depth: 3/);
  assert.match(out, /Transcriber: local/);
  assert.match(out, /5 files \/ 9 aliases/);
});

test("formatHealth renders one line per upstream", () => {
  const now = 1_000_000;
  const out = formatHealth(
    [
      {
        name: "anthropic",
        up: true,
        latencyMs: 120,
        error: null,
        failures: 0,
        since: 0,
      },
      {
        name: "groq",
        up: false,
        latencyMs: 5001,
        error: "HTTP 401",
        failures: 3,
        since: now - 180_000,
      },
      {
        name: "parakeet",
        up: true,
        latencyMs: null,
        error: null,
        failures: 0,
        since: now,
      },
    ],
    now,
  );
  assert.deepEqual(out.split("\n"), [
    "Upstreams:",
    "🟢 anthropic · 120 ms",
    "🔴 groq · down 3m 0s · 5001 ms · HTTP 401",
    "🟢 parakeet · not probed yet",
  ]);
});

test("formatHealth caps a long error", () => {
  const out = formatHealth(
    [
      {
        name: "obsidian",
        up: true,
        latencyMs: 40,
        error: "x ".repeat(200),
        failures: 1,
        since: 0,
      },
    ],
    0,
  );
  assert.ok(out.split("\n")[1]!.length < 180);
  // one failed probe is a warning, not green
  assert.ok(out.split("\n")[1]!.startsWith("🟡 obsidian"));
});

test("modelsUrlFor swaps the transcription path for the model listing", () => {
  assert.equal(
    modelsUrlFor("http://parakeet:5092/v1/audio/transcriptions"),
    "http://parakeet:5092/v1/models",
  );
  assert.equal(
    modelsUrlFor("http://parakeet:5092/v1/audio/transcriptions/?x=1"),
    "http://parakeet:5092/v1/models",
  );
  assert.equal(modelsUrlFor("http://asr:9000"), "http://asr:9000/models");
});

test("formatStatus shows a disabled link index", () => {
  const out = formatStatus({
    counts: {
      pending: 0,
      processing: 0,
      done: 0,
      failed: 0,
      abandoned: 0,
      deleted: 0,
    },
    queueDepth: 0,
    transcriber: "remote",
    links: { enabled: false, files: 0, aliases: 0 },
    version: "1",
    sha: "0000000",
    uptimeMs: 0,
  });
  assert.match(out, /Link index: disabled/);
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

test("isInsideRoot accepts the root and its children, rejects siblings", () => {
  assert.equal(isInsideRoot("/vault", "/vault"), true);
  assert.equal(isInsideRoot("/vault", "/vault/notes/a.md"), true);
  assert.equal(isInsideRoot("/vault/", "/vault/a.md"), true);
  assert.equal(isInsideRoot("/vault", "/vault-other/a.md"), false); // prefix, not child
  assert.equal(isInsideRoot("/vault", "/etc/passwd"), false);
  assert.equal(isInsideRoot("", "/vault/a.md"), false);
});

test("entitiesToMarkdown returns text unchanged when entities is undefined", () => {
  assert.equal(entitiesToMarkdown("hello world", undefined), "hello world");
});
test("entitiesToMarkdown returns text unchanged when entities is empty", () => {
  assert.equal(entitiesToMarkdown("hello world", []), "hello world");
});
test("entitiesToMarkdown wraps bold in **", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [{ type: "bold", offset: 6, length: 5 }]),
    "hello **world**",
  );
});
test("entitiesToMarkdown wraps italic in _", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "italic", offset: 6, length: 5 },
    ]),
    "hello _world_",
  );
});
test("entitiesToMarkdown wraps code in backticks", () => {
  assert.equal(
    entitiesToMarkdown("I added things to internal", [
      { type: "code", offset: 18, length: 8 },
    ]),
    "I added things to `internal`",
  );
});
test("entitiesToMarkdown wraps strike in ~~", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "strikethrough", offset: 6, length: 5 },
    ]),
    "hello ~~world~~",
  );
});
test("entitiesToMarkdown wraps spoiler in ||", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "spoiler", offset: 6, length: 5 },
    ]),
    "hello ||world||",
  );
});
test("entitiesToMarkdown wraps underline in __", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "underline", offset: 6, length: 5 },
    ]),
    "hello __world__",
  );
});
test("entitiesToMarkdown wraps text_link in Markdown link", () => {
  assert.equal(
    entitiesToMarkdown("hello example", [
      { type: "text_link", offset: 6, length: 7, url: "https://example.com" },
    ]),
    "hello [example](https://example.com)",
  );
});
test("entitiesToMarkdown wraps pre with language", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "pre", offset: 6, length: 5, language: "ts" },
    ]),
    "hello ```ts\nworld\n```",
  );
});
test("entitiesToMarkdown wraps pre without language", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [{ type: "pre", offset: 6, length: 5 }]),
    "hello ```\nworld\n```",
  );
});
test("entitiesToMarkdown handles multiple entities sorted by offset", () => {
  const text = "abcboldandcode";
  assert.equal(
    entitiesToMarkdown(text, [
      { type: "code", offset: 10, length: 4 },
      { type: "bold", offset: 3, length: 4 },
    ]),
    "abc**bold**and`code`",
  );
});
test("entitiesToMarkdown skips nested entities instead of duplicating text", () => {
  // bold spanning the whole string with a link nested inside it: keep the
  // outer formatting, drop the inner one, never re-emit the covered text.
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "bold", offset: 0, length: 11 },
      { type: "text_link", offset: 0, length: 5, url: "https://x.com" },
    ]),
    "**hello world**",
  );
});
test("entitiesToMarkdown preserves text before the first entity and after the last", () => {
  assert.equal(
    entitiesToMarkdown("before code after", [
      { type: "code", offset: 7, length: 4 },
    ]),
    "before `code` after",
  );
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

test("formatListPage clamps the page and footers what is off screen", () => {
  const items = Array.from({ length: 5 }, (_, i) => `item${i + 1}`);
  // One page fits: no footer at all.
  assert.equal(formatListPage(items, 0, 10, "/x"), items.join("\n"));

  const first = formatListPage(items, 0, 2, "/x");
  assert.match(first, /^item1\nitem2\n\n/);
  assert.match(first, /Showing 1–2 of 5 · page 1\/3 · next: \/x 2$/);

  // Last page is short and points back to the start rather than a page that isn't there.
  const last = formatListPage(items, 2, 2, "/x");
  assert.match(last, /^item5\n\n/);
  assert.match(
    last,
    /Showing 5–5 of 5 · page 3\/3 · back to the start: \/x 1$/,
  );

  // Out-of-range pages clamp instead of rendering an empty body.
  assert.equal(formatListPage(items, 99, 2, "/x"), last);
  assert.equal(formatListPage(items, -3, 2, "/x"), first);

  // A custom separator keeps the footer on its own line.
  assert.match(formatListPage(items, 0, 2, "/x", ", "), /^item1, item2\n\n/);
});
