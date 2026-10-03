import assert from "node:assert/strict";
import { test } from "node:test";
import {
  errorText,
  escapeHtml,
  fitTelegram,
  formatDuration,
  htmlToText,
  pluralize,
  previewList,
  shortId,
  splitEntry,
  TELEGRAM_LIMIT,
} from "./text.ts";

test("errorText reads an Error's message and stringifies anything else", () => {
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("plain"), "plain");
  assert.equal(errorText(42), "42");
});

test("ids are fixed 8-char hex", () => {
  const id = shortId();
  assert.match(id, /^[0-9a-f]{8}$/);
});

test("splitEntry keeps short text whole and never cuts a sentence", () => {
  assert.deepEqual(splitEntry("short one", 280), ["short one"]);
  assert.deepEqual(splitEntry("  ", 280), []);
  // Splitting off: length stops mattering.
  assert.deepEqual(splitEntry("a".repeat(400), 0), ["a".repeat(400)]);
  // A single sentence over the limit goes out whole rather than being cut.
  const long = `${"word ".repeat(80)}end.`;
  assert.deepEqual(splitEntry(long, 100), [long.replace(/\s+/g, " ").trim()]);

  const three = "First one here. Second one here. Third one here.";
  assert.deepEqual(splitEntry(three, 20), [
    "First one here.",
    "Second one here.",
    "Third one here.",
  ]);
  // Sentences pack greedily up to the limit.
  assert.deepEqual(splitEntry(three, 34), [
    "First one here. Second one here.",
    "Third one here.",
  ]);
});

test("splitEntry splits on topics first and collapses each chunk to one line", () => {
  const text = "Topic one. Still topic one.\n\nTopic two entirely.";
  assert.deepEqual(splitEntry(text, 30), [
    "Topic one. Still topic one.",
    "Topic two entirely.",
  ]);
  // Under the limit it stays one entry, newlines and all.
  assert.deepEqual(splitEntry(text, 280), [
    "Topic one. Still topic one. Topic two entirely.",
  ]);
  // An abbreviation isn't a sentence end: "e.g." keeps its lowercase follower.
  assert.deepEqual(
    splitEntry("Bought stuff e.g. milk and eggs. Then went home.", 40),
    ["Bought stuff e.g. milk and eggs.", "Then went home."],
  );
});

test("escapeHtml neutralises Telegram HTML metacharacters", () => {
  assert.equal(
    escapeHtml(`a <b> & "c" 'd'`),
    "a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;",
  );
});

test("pluralize suffixes -s for everything but 1", () => {
  assert.equal(pluralize(1, "jot"), "1 jot");
  assert.equal(pluralize(0, "jot"), "0 jots");
  assert.equal(pluralize(3, "jot"), "3 jots");
});

test("formatDuration picks the two coarsest units", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(3 * 3600_000 + 20 * 60_000), "3h 20m");
  assert.equal(formatDuration(2 * 86400_000 + 5 * 3600_000), "2d 5h");
});

test("htmlToText drops script/style bodies instead of running them", () => {
  const html = `<html><head><title>t</title><style>body{color:red}</style></head>
<body><script>alert('x')</script><h1>Title</h1><p>First &amp; second.</p>
<ul><li>one</li><li>two</li></ul><div>after</div></body></html>`;
  const out = htmlToText(html);
  assert.doesNotMatch(out, /alert|color:red|<[a-z]/i); // no code, no tags left
  assert.match(out, /Title/);
  assert.match(out, /First & second\./); // entities decoded
  // Hex entities too: tropes.fyi serves its list full of &#x27;
  assert.equal(
    htmlToText("<p>What&#x27;s new &#8212; ok</p>"),
    "What's new — ok",
  );
  assert.match(out, /- one/);
  assert.match(out, /after/);
  assert.doesNotMatch(out, /\n\n\n/); // blank runs collapsed
});

test("fitTelegram leaves short text alone and labels the cut on long text", () => {
  assert.equal(fitTelegram("short"), "short");
  const long = "x".repeat(TELEGRAM_LIMIT + 500);
  const out = fitTelegram(long);
  assert.equal(out.length, TELEGRAM_LIMIT);
  assert.match(out, /cut here/);
  // The custom limit is honoured too, so the notice can never itself overflow.
  assert.equal(fitTelegram("y".repeat(300), 200).length, 200);
});

test("previewList counts what it leaves out instead of cutting silently", () => {
  assert.equal(previewList(["a", "b"], 5), "a, b");
  assert.equal(previewList([], 5), "");
  assert.equal(previewList(["a", "b", "c", "d"], 2), "a, b … +2 more");
});
