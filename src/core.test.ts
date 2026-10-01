import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_UPDATE_CHARS,
  assetEmbed,
  CircuitBreaker,
  candidates,
  cleanNoteTitle,
  clipUpdate,
  combineEnrichSource,
  DEFAULT_ENTRY_MAX_CHARS,
  distinctSurfaces,
  doneMessage,
  donePreview,
  editConfirmation,
  editedJotText,
  embedOffer,
  enrichableSource,
  entitiesToMarkdown,
  entryMaxChars,
  feedMessage,
  fitFeed,
  followupQuestions,
  followupRef,
  forcedCandidates,
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
  isEditableJot,
  isEmbeddableUrl,
  isInsideRoot,
  isRecoverable,
  jotPreview,
  linkDateWords,
  makeJotId,
  modelsUrlFor,
  monthGrid,
  noteSuggestions,
  parseClockTime,
  parseEntrySize,
  parseFollowupRef,
  parseLiteralEdit,
  parseModelJson,
  parseRuleWords,
  parseWizardRef,
  previewList,
  queuedNotice,
  ratingDay,
  ratingTime,
  reprocessTargets,
  retryNotice,
  setEmbeds,
  switchEnabled,
  TELEGRAM_LIMIT,
  thoughtIcon,
  tokenize,
  toolIcon,
  unwrapModelPayload,
  WIZARD_ENTRYSIZE_REF,
  WIZARD_NOTE_REF,
  WIZARD_RATING_TIME_REF,
  WIZARD_REGISTER_REF,
  WIZARD_STOPWORD_REF,
  withinSquashWindow,
} from "./core.ts";
import type { Jot, StatsRow } from "./db.ts";
import { parseHabitRef } from "./flows/habits/parse.ts";
import type { ReleaseNote } from "./services/github.ts";

const STOP = new Set(["no", "we", "i", "on", "e", "de"]);

test("withinSquashWindow: rolling gap folds jots within the window, splits past it", () => {
  assert.equal(withinSquashWindow(1000, 12000, 15000), true); // 11s gap ≤ 15s
  assert.equal(withinSquashWindow(1000, 16001, 15000), false); // 15.001s gap > 15s
  assert.equal(withinSquashWindow(1000, 16000, 15000), true); // exactly 15s
  assert.equal(withinSquashWindow(1000, 2000, 0), false); // window 0 disables
});

test("combineEnrichSource joins parts, dropping blanks", () => {
  assert.equal(
    combineEnrichSource(["first", "  ", "second", ""]),
    "first\nsecond",
  );
  assert.equal(combineEnrichSource([]), "");
  assert.equal(combineEnrichSource([" solo "]), "solo");
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

test("ids are fixed 8-char hex", () => {
  const id = makeJotId();
  assert.match(id, /^[0-9a-f]{8}$/);
});

test("editedJotText strips a re-typed TIL marker only for TIL jots", () => {
  assert.equal(
    editedJotText("til", "TIL: sqlite has WAL mode"),
    "sqlite has WAL mode",
  );
  assert.equal(
    editedJotText("til", "sqlite has WAL mode"),
    "sqlite has WAL mode",
  );
  assert.equal(editedJotText("til", "TIL"), "TIL");
  assert.equal(editedJotText("journal", "TIL: foo"), "TIL: foo");
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

test("entryMaxChars falls back to the default, parseEntrySize validates input", () => {
  assert.equal(entryMaxChars(undefined), DEFAULT_ENTRY_MAX_CHARS);
  assert.equal(entryMaxChars(""), DEFAULT_ENTRY_MAX_CHARS);
  assert.equal(entryMaxChars("nonsense"), DEFAULT_ENTRY_MAX_CHARS);
  assert.equal(entryMaxChars("-5"), DEFAULT_ENTRY_MAX_CHARS);
  assert.equal(entryMaxChars("0"), 0);
  assert.equal(entryMaxChars("140"), 140);

  assert.equal(parseEntrySize("280"), 280);
  assert.equal(parseEntrySize(" off "), 0);
  assert.equal(parseEntrySize("0"), 0);
  assert.equal(parseEntrySize("10"), null); // no sentence fits
  assert.equal(parseEntrySize("99999"), null);
  assert.equal(parseEntrySize("lots"), null);
});

test("candidates drop stopwords/short aliases and honour rejections", () => {
  const index = [
    { note: "Norway", alias: "no" }, // stopword → dropped
    { note: "Norway", alias: "Norway" }, // real → kept
    { note: "We (novel)", alias: "We" }, // 2 chars → dropped
    { note: "Fume Extractor", alias: "Fume Extractor" }, // multiword → kept
    { note: "Lev", alias: "Lev" },
  ];
  const text =
    "I said no to visiting Norway but fixed the Fume Extractor for Lev";
  const got = candidates(text, index, STOP, new Set());
  assert.deepEqual(got.map((c) => c.note).sort(), [
    "Fume Extractor",
    "Lev",
    "Norway",
  ]);

  const rejected = new Set(["lev Lev"]); // user previously said no to Lev
  const got2 = candidates(text, index, STOP, rejected);
  assert.ok(!got2.some((c) => c.note === "Lev"));
});

test("forcedCandidates: matches registered surface->note pairs, ignoring length/stopword rules, marked forced", () => {
  const registered = [
    { surface: "no", note: "Norway" }, // 2 chars + a stopword elsewhere — still forced
    { surface: "Fume Extractor", note: "Fume Extractor" }, // multiword
    { surface: "gym", note: "Fitness" },
  ];
  const text = "said no to visiting the Fume Extractor room";
  const got = forcedCandidates(text, registered);
  assert.deepEqual(
    got.map((c) => [c.surface, c.note, c.forced]).sort(),
    [
      ["Fume Extractor", "Fume Extractor", true],
      ["no", "Norway", true],
    ].sort(),
  );
});

test("linkDateWords turns relative date phrases into daily-note wikilinks", () => {
  const ref = "2026-07-10"; // a Friday
  assert.equal(
    linkDateWords("I did this yesterday", ref),
    "I did this [[2026-07-09|yesterday]]",
  );
  assert.equal(
    linkDateWords("see you tomorrow", ref),
    "see you [[2026-07-11|tomorrow]]",
  );
  assert.equal(
    linkDateWords("I went to the beach three weeks ago", ref),
    "I went to the beach [[2026-06-19|three weeks ago]]",
  );
  assert.equal(
    linkDateWords("in 2 days we ship", ref),
    "[[2026-07-12|in 2 days]] we ship",
  );
  assert.equal(
    linkDateWords("last month was rough", ref),
    "[[2026-06-10|last month]] was rough",
  );
});

test("linkDateWords ignores bare clock times that carry no date", () => {
  const ref = "2026-07-10";
  assert.equal(linkDateWords("Call is at 3pm", ref), "Call is at 3pm");
  assert.equal(linkDateWords("We land at 22:30", ref), "We land at 22:30");
  assert.equal(linkDateWords("meeting at 9", ref), "meeting at 9");
  // but a time attached to an actual day keyword still links
  assert.equal(
    linkDateWords("Met the doctor at 3pm today", ref),
    "Met the doctor [[2026-07-10|at 3pm today]]",
  );
});

test("linkDateWords leaves a 'for <duration>' span alone", () => {
  const ref = "2026-09-28";
  assert.equal(
    linkDateWords("in the dryer for a week now", ref),
    "in the dryer for a week now",
  );
  assert.equal(
    linkDateWords("I stayed there for 3 days", ref),
    "I stayed there for 3 days",
  );
  // a real relative date still links
  assert.equal(
    linkDateWords("see you in a week", ref),
    "see you [[2026-10-05|in a week]]",
  );
});

test("linkDateWords never links a date word buried inside a bigger word", () => {
  const ref = "2026-07-10";
  // "Pokémon" tripped this: JS `\b` is ASCII-only, so é read as a word break and "mon"
  // looked like a standalone Monday.
  assert.equal(
    linkDateWords("played Pokémon all day", ref).includes("[[2026"),
    false,
  );
  assert.equal(
    linkDateWords("the satsuma is ripe", ref),
    "the satsuma is ripe",
  );
  // the same words on their own still link
  assert.equal(
    linkDateWords("shipping it mon", ref),
    "shipping it [[2026-07-13|mon]]",
  );
});

test('linkDateWords leaves "now" alone but still links "today" in the same sentence', () => {
  const ref = "2026-07-10";
  assert.equal(
    linkDateWords("it's good now, deploy maybe tomorrow, or today", ref),
    "it's good now, deploy maybe [[2026-07-11|tomorrow]], or [[2026-07-10|today]]",
  );
  assert.equal(
    linkDateWords("just now I fixed it", ref),
    "just now I fixed it",
  );
});

test("linkDateWords ignores plain text and never re-links inside a wikilink", () => {
  const ref = "2026-07-10";
  assert.equal(linkDateWords("no date words here", ref), "no date words here");
  assert.equal(linkDateWords("", ref), "");
  assert.equal(
    linkDateWords("read [[Monday Blues]] again", ref),
    "read [[Monday Blues]] again",
  );
});

test("literal edit parser handles sed and natural forms, rejects freeform", () => {
  assert.deepEqual(parseLiteralEdit("s/pot/potentiometer/"), {
    old: "pot",
    new: "potentiometer",
  });
  assert.deepEqual(parseLiteralEdit("replace pot with potentiometer"), {
    old: "pot",
    new: "potentiometer",
  });
  assert.deepEqual(parseLiteralEdit('replace "the cat" with "the dog"'), {
    old: "the cat",
    new: "the dog",
  });
  assert.equal(parseLiteralEdit("make this clearer"), null);
});

test("tokenize keeps accented letters", () => {
  assert.deepEqual(tokenize("Não é fácil"), ["não", "é", "fácil"]);
});

test("donePreview shows enriched text in full, labels attach-only", () => {
  assert.equal(donePreview("text", "  went for a run  "), "went for a run");
  assert.equal(donePreview("audio", "x".repeat(250)), "x".repeat(250));
  assert.equal(donePreview("image", ""), "image saved to the note");
  assert.equal(donePreview("video", "  "), "video saved to the note");
  assert.equal(donePreview("text", ""), "saved");
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
  const base: StatsRow = {
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

test("isRecoverable flags transient infra errors, not terminal ones", () => {
  assert.equal(
    isRecoverable(new Error("connect ETIMEDOUT 10.0.0.1:443")),
    true,
  );
  assert.equal(
    isRecoverable(new Error("Request failed with status 503")),
    true,
  );
  assert.equal(isRecoverable(new Error("429 Too Many Requests")), true);
  assert.equal(isRecoverable(new Error("invalid path")), false);
});

test("isEditableJot is true only for done/abandoned (a line exists to edit)", () => {
  assert.equal(isEditableJot("done"), true);
  assert.equal(isEditableJot("abandoned"), true);
  assert.equal(isEditableJot("pending"), false);
  assert.equal(isEditableJot("processing"), false);
  assert.equal(isEditableJot("failed"), false);
  assert.equal(isEditableJot("deleted"), false);
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

const mediaJot = (over: Partial<Jot>): Jot => ({
  id: "deadbeef",
  kind: "image",
  note_path: "notes/x.md",
  anchor: "deadbeef",
  time: "10:00:00",
  raw_text: null,
  transcript: null,
  proposed_text: null,
  section: "journal",
  asset_path: null,
  file_id: null,
  status: "done",
  attempts: 0,
  error: null,
  received_at: 0,
  updated_at: 0,
  ...over,
});

test("an image's caption is enrichable entry text; video's is not", () => {
  // What you type alongside a photo is the jot itself, so it goes through enrichment.
  assert.equal(
    enrichableSource(mediaJot({ kind: "image", raw_text: "at the park" })),
    "at the park",
  );
  assert.equal(enrichableSource(mediaJot({ kind: "image" })), "");
  // Video stays attach-only — its caption is the embed's display text, not entry text.
  assert.equal(
    enrichableSource(mediaJot({ kind: "video", raw_text: "clip of the dog" })),
    "",
  );
  assert.equal(
    enrichableSource(mediaJot({ kind: "audio", transcript: "spoken" })),
    "spoken",
  );
  assert.equal(
    enrichableSource(mediaJot({ kind: "audio" }), "(failed)"),
    "(failed)",
  );
});

test("isEmbeddableUrl knows YouTube, tweets and images, nothing else", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=NnTvZWp5Q7o",
    "https://youtu.be/NnTvZWp5Q7o",
    "https://twitter.com/obsdmd/status/1580548874246443010",
    "https://x.com/obsdmd/status/1580548874246443010",
    "https://example.com/cat.JPG?w=300",
  ])
    assert.ok(isEmbeddableUrl(url), url);
  for (const url of [
    "https://www.youtube.com/@obsidianmd",
    "https://x.com/obsdmd",
    "https://example.com/post",
  ])
    assert.ok(!isEmbeddableUrl(url), url);
});

test("embedOffer asks to embed, then offers plain once embedded", () => {
  const yt = "https://youtu.be/abc";
  assert.equal(embedOffer("just text"), undefined);
  assert.equal(embedOffer("read https://example.com/post"), undefined);
  assert.equal(embedOffer(`watch ${yt}`), "embed");
  assert.equal(embedOffer(`watch [this](${yt})`), "embed");
  assert.equal(embedOffer(`watch ![](${yt})`), "plain");
  // One still linked is enough to offer embedding the rest.
  assert.equal(embedOffer(`![](${yt}) and ${yt}`), "embed");
});

test("setEmbeds round-trips bare and labelled links", () => {
  const yt = "https://www.youtube.com/watch?v=abc&t=10";
  const line = `saw ${yt}. also [cat](https://e.com/c.png) and https://e.com/page, [[Note]]`;
  const embedded = setEmbeds(line, true);
  assert.equal(
    embedded,
    `saw ![](${yt}). also ![cat](https://e.com/c.png) and https://e.com/page, [[Note]]`,
  );
  assert.equal(setEmbeds(embedded, true), embedded);
  assert.equal(setEmbeds(embedded, false), line);
});

test("assetEmbed gives an image no alias and a video its caption", () => {
  // Telegram exposes no alt-text field, and the caption is already the entry text — so
  // an image embeds bare rather than repeating itself inside the link.
  assert.equal(
    assetEmbed(
      mediaJot({
        kind: "image",
        raw_text: "at the park",
        asset_path: "a/b.jpg",
      }),
    ),
    "![[a/b.jpg]]",
  );
  assert.equal(
    assetEmbed(
      mediaJot({ kind: "video", raw_text: "the dog", asset_path: "a/b.mp4" }),
    ),
    "![[a/b.mp4|the dog]]",
  );
  assert.equal(
    assetEmbed(mediaJot({ kind: "video", asset_path: "a/b.mp4" })),
    "![[a/b.mp4]]",
  );
  assert.equal(assetEmbed(mediaJot({ kind: "text", raw_text: "hi" })), "");
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

test("parseClockTime takes valid 24h times and pads the hour", () => {
  for (const [input, out] of [
    ["0:00", "00:00"],
    ["00:59", "00:59"],
    ["19:05", "19:05"],
    ["23:00", "23:00"],
    ["1:00", "01:00"],
  ])
    assert.equal(parseClockTime(input!), out, input);
});

test("parseClockTime rejects malformed, non-ASCII and multi-line input", () => {
  for (const bad of [
    "24:00",
    "2:60",
    "-1:00",
    "1:2:3",
    "12:00:00",
    "12.30",
    "１２:３０",
    "12:30pm",
    "12:30\n13:00",
    " ",
    "\t",
    ":30",
    "12:",
    "abc",
    "🕛",
  ])
    assert.equal(parseClockTime(bad), null, JSON.stringify(bad));
});

test("ratingTime normalises the fallback too, and ratingDay reads an unpadded hour", () => {
  assert.equal(ratingTime(undefined, "9:30"), "09:30");
  assert.equal(ratingTime("garbage", "9:30"), "09:30");
  assert.equal(ratingTime("8:05", "00:00"), "08:05");
  const now = new Date(2026, 6, 6, 12, 0).getTime();
  assert.equal(ratingDay("9:30", now), "2026-07-05");
});

test("ratingDay rolls back across month, year and leap-day boundaries", () => {
  const at = (y: number, m: number, d: number) =>
    new Date(y, m, d, 0, 0).getTime();
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

test("switchEnabled is on unless explicitly off", () => {
  assert.equal(switchEnabled(undefined), true);
  assert.equal(switchEnabled("on"), true);
  assert.equal(switchEnabled("off"), false);
});

test("parseClockTime accepts 24h HH:MM and pads a single-digit hour", () => {
  assert.equal(parseClockTime("00:00"), "00:00");
  assert.equal(parseClockTime(" 23:59 "), "23:59");
  assert.equal(parseClockTime("9:30"), "09:30");
});

test("parseClockTime rejects anything else", () => {
  for (const bad of [
    "24:00",
    "12:60",
    "7pm",
    "12",
    "12:5",
    "1230",
    "",
    "ab:cd",
  ])
    assert.equal(parseClockTime(bad), null, bad);
});

test("ratingTime uses the stored time when valid, else the default", () => {
  assert.equal(ratingTime("22:15", "00:00"), "22:15");
  assert.equal(ratingTime(undefined, "00:00"), "00:00");
  assert.equal(ratingTime("garbage", "21:00"), "21:00");
});

test("ratingDay rates yesterday for a just-after-midnight time and today for an evening one", () => {
  const now = new Date(2026, 6, 6, 12, 0, 0).getTime();
  assert.equal(ratingDay("00:00", now), "2026-07-05");
  assert.equal(ratingDay("11:59", now), "2026-07-05");
  assert.equal(ratingDay("12:00", now), "2026-07-06");
  assert.equal(ratingDay("22:30", now), "2026-07-06");
});

test("parseRuleWords keeps inner spaces, splits on commas and newlines", () => {
  assert.deepEqual(parseRuleWords("Priscilla, Path Of Exile"), [
    "priscilla",
    "path of exile",
  ]);
  assert.deepEqual(parseRuleWords(" Gym \n mom\nGYM ,, "), ["gym", "mom"]);
  assert.deepEqual(parseRuleWords("   "), []);
  assert.deepEqual(parseRuleWords(`ok, ${"x".repeat(61)}`), ["ok"]);
  assert.deepEqual(parseRuleWords("a,b,c", 2), ["a", "b"]);
});

test("cleanNoteTitle strips wikilink brackets, quotes and stray whitespace", () => {
  assert.equal(
    cleanNoteTitle("  [[Priscilla  Rebouças]] "),
    "Priscilla Rebouças",
  );
  assert.equal(cleanNoteTitle('"POE"'), "POE");
  assert.equal(cleanNoteTitle("   "), "");
});

test("noteSuggestions ranks exact over prefix over substring, one row per note", () => {
  const index = [
    { note: "Path Of Exile", alias: "Path Of Exile" },
    { note: "Path Of Exile", alias: "POE" }, // same note, second alias
    { note: "Pathfinder", alias: "Pathfinder" },
    { note: "My POE Build", alias: "My POE Build" },
    { note: "Health", alias: "Gym" },
  ];
  assert.deepEqual(noteSuggestions("poe", index), [
    "Path Of Exile", // exact alias hit
    "My POE Build", // substring
  ]);
  assert.deepEqual(noteSuggestions("path", index), [
    "Pathfinder", // prefix, shorter alias wins the tie
    "Path Of Exile",
  ]);
  assert.deepEqual(noteSuggestions("nothing here", index), []);
  assert.deepEqual(noteSuggestions("", index), []);
  assert.equal(noteSuggestions("path", index, 1).length, 1);
});

test("distinctSurfaces dedupes surfaces, preserving list order", () => {
  assert.deepEqual(
    distinctSurfaces([
      { surface: "gym", note: "Health" },
      { surface: "gym", note: "Fitness" },
      { surface: "mom", note: "Family" },
    ]),
    ["gym", "mom"],
  );
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

test("reprocessTargets dedupes to leader ids, preserving first-seen order", () => {
  assert.deepEqual(
    reprocessTargets([
      { anchor: "leader1" },
      { anchor: "leader1" }, // follower sharing leader1's anchor
      { anchor: "leader2" },
    ]),
    ["leader1", "leader2"],
  );
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

test("parseModelJson reads clean, fenced, prose-wrapped and line-broken JSON", () => {
  assert.deepEqual(parseModelJson('{"text":"a"}'), { text: "a" });
  assert.deepEqual(parseModelJson('```json\n{"text":"a"}\n```'), { text: "a" });
  assert.deepEqual(parseModelJson('Sure: {"text":"a"} ok'), { text: "a" });
  assert.deepEqual(parseModelJson('{"text": "a\n\nb\tc"}'), {
    text: "a\n\nb\tc",
  });
  assert.deepEqual(parseModelJson('{\n  "text": "a"\n}'), { text: "a" });
  assert.equal(parseModelJson("no json here"), null);
  assert.equal(parseModelJson("[1,2]"), null);
  assert.equal(parseModelJson('{"text": "unterminated'), null);
});

test("unwrapModelPayload unwraps a nested answer and keeps the inner lists", () => {
  const nested = {
    text: '{"text": "Also [[2026-09-29|Tuesday]] I have an interview", "ambiguous": [], "tasks": [{"description": "Go to the interview", "type": "personal"}]}',
    ambiguous: [],
    tasks: [],
  };
  const out = unwrapModelPayload(nested);
  assert.equal(out.text, "Also [[2026-09-29|Tuesday]] I have an interview");
  assert.deepEqual(out.tasks, [
    { description: "Go to the interview", type: "personal" },
  ]);
});

test("unwrapModelPayload keeps outer lists when they're already filled", () => {
  const out = unwrapModelPayload({
    text: '{"text": "hi", "ambiguous": [{"surface":"x","note":"y"}]}',
    ambiguous: [{ surface: "a", note: "b" }],
  });
  assert.equal(out.text, "hi");
  assert.deepEqual(out.ambiguous, [{ surface: "a", note: "b" }]);
});

test("unwrapModelPayload takes an inner til when the outer one is not true", () => {
  const nested = (til: unknown) =>
    unwrapModelPayload({ text: '{"text": "hi", "til": true}', til }).til;
  assert.equal(nested(false), true);
  assert.equal(nested(undefined), true);
  assert.equal(
    unwrapModelPayload({ text: '{"text":"hi","til":false}', til: true }).til,
    true,
  );
  assert.equal(
    unwrapModelPayload({ text: '{"text":"hi","til":"no"}', til: false }).til,
    "no",
  );
});

test("unwrapModelPayload keeps a missing til missing and an outer false false", () => {
  assert.equal(
    unwrapModelPayload({ text: '{"text":"hi"}', til: false }).til,
    false,
  );
  const none = unwrapModelPayload({ text: '{"text":"hi"}' });
  assert.equal(none.til, undefined);
  assert.ok("til" in none);
});

test("unwrapModelPayload keeps a til the model put in the inner answer", () => {
  const out = unwrapModelPayload({
    text: '{"text": "hi", "ambiguous": [], "til": true}',
    til: false,
  });
  assert.equal(out.til, true);
});

test("unwrapModelPayload unwraps several levels and strips an echoed fence", () => {
  const lvl2 = JSON.stringify({ text: '"""deep"""' });
  const lvl1 = JSON.stringify({ text: lvl2 });
  assert.equal(unwrapModelPayload({ text: lvl1 }).text, "deep");
});

test("unwrapModelPayload leaves ordinary text alone, braces included", () => {
  for (const text of [
    "Plain entry with [[Link]]",
    "{curly} is how I write sets",
    '{"not": "a payload"}',
    'She said """hi""" in the middle',
  ])
    assert.equal(unwrapModelPayload({ text }).text, text);
});

test("CircuitBreaker opens after the threshold, lets one trial through after the cooldown", () => {
  const t = { now: 0 };
  const b = new CircuitBreaker(2, 100, () => t.now);
  b.failure(new Error("a"));
  assert.equal(b.allows(), true);
  b.failure(new Error("b"));
  assert.equal(b.allows(), false);
  assert.equal((b.lastError as Error).message, "b");
  t.now = 100;
  assert.equal(b.allows(), true);
  // the trial fails: straight back open, no second run-up to the threshold
  b.failure(new Error("c"));
  assert.equal(b.allows(), false);
  t.now = 200;
  b.success();
  assert.equal(b.allows(), true);
  b.failure(new Error("d"));
  assert.equal(b.allows(), true);
});

test("isRecoverable covers the OpenAI-shaped SDKs' network errors", () => {
  assert.equal(isRecoverable(new Error("Connection error.")), true);
  assert.equal(isRecoverable(new Error("Request timed out.")), true);
  assert.equal(
    isRecoverable(new Error("timeout after 15s (claude-haiku-4-5)")),
    true,
  );
});
