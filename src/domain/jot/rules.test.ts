import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleJot } from "../../test/sqlite.ts";
import type { Jot } from "./entity.ts";
import {
  assetEmbed,
  combineEnrichSource,
  editedJotText,
  emptyStatusCounts,
  enrichableSource,
  entryContent,
  isEditableJot,
  isFollower,
  isReprocessable,
  jotDay,
  journalLine,
  placeholderLine,
  reprocessTargets,
  sourceField,
  stripJournalLine,
  stripTilPrefix,
  withinSquashWindow,
} from "./rules.ts";

test("withinSquashWindow: rolling gap folds jots within the window, splits past it", () => {
  assert.equal(withinSquashWindow(1000, 12000, 15000), true); // 11s apart ≤ 15s
  assert.equal(withinSquashWindow(1000, 16001, 15000), false); // 15.001s apart > 15s
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

test("isEditableJot is true only for done/abandoned (a line exists to edit)", () => {
  assert.equal(isEditableJot("done"), true);
  assert.equal(isEditableJot("abandoned"), true);
  assert.equal(isEditableJot("pending"), false);
  assert.equal(isEditableJot("processing"), false);
  assert.equal(isEditableJot("failed"), false);
  assert.equal(isEditableJot("deleted"), false);
});

test("isReprocessable is true for finished jots, not for in-flight or deleted ones", () => {
  for (const status of ["done", "failed", "abandoned"] as const)
    assert.equal(isReprocessable(status), true, status);
  for (const status of ["pending", "processing", "deleted"] as const)
    assert.equal(isReprocessable(status), false, status);
});

const mediaJot = (over: Partial<Jot>): Jot =>
  sampleJot("deadbeef", {
    kind: "image",
    note_path: "notes/x.md",
    raw_text: null,
    status: "done",
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
  // Video stays attach-only: its caption is the embed's display text, not entry text.
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

test("assetEmbed gives an image no alias and a video its caption", () => {
  // Telegram exposes no alt-text field, and the caption is already the entry text, so
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

test("a jot is a follower when its anchor is another jot's id", () => {
  assert.equal(isFollower({ id: "aaaaaaaa", anchor: "aaaaaaaa" }), false);
  assert.equal(isFollower({ id: "bbbbbbbb", anchor: "aaaaaaaa" }), true);
});

test("sourceField names the column a kind keeps its text in", () => {
  assert.equal(sourceField("audio"), "transcript");
  for (const kind of ["text", "image", "video"] as const)
    assert.equal(sourceField(kind), "raw_text", kind);
});

test("entryContent joins the entry and the asset embed, and is empty when both are", () => {
  const image = mediaJot({ kind: "image", asset_path: "a/b.jpg" });
  assert.equal(entryContent(image, "at the park"), "at the park ![[a/b.jpg]]");
  assert.equal(entryContent(image, ""), "![[a/b.jpg]]");
  assert.equal(entryContent(mediaJot({ kind: "text" }), ""), "");
});

test("jotDay is the note file's name", () => {
  assert.equal(
    jotDay({ note_path: "notes/daily notes/2026-10-03.md" }),
    "2026-10-03",
  );
});

test("emptyStatusCounts zeroes every status and hands out a fresh object", () => {
  const counts = emptyStatusCounts();
  assert.deepEqual(counts, {
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    abandoned: 0,
    deleted: 0,
  });
  counts.done = 1;
  assert.equal(emptyStatusCounts().done, 0);
});

test("journal + placeholder lines match the vault house style", () => {
  assert.equal(
    journalLine("23:13:18", "hi", "a1b2c3d4"),
    "- _23:13:18 ::_ hi ^a1b2c3d4",
  );
  assert.equal(
    placeholderLine("09:00:00", "deadbeef"),
    "- _09:00:00 ::_ ⏳ ^deadbeef",
  );
});

test("stripTilPrefix drops a leading TIL marker in its usual spellings", () => {
  assert.equal(stripTilPrefix("TIL foo"), "foo");
  assert.equal(stripTilPrefix("til foo"), "foo");
  assert.equal(stripTilPrefix("TIL: foo"), "foo");
  assert.equal(stripTilPrefix("TIL:foo"), "foo");
  assert.equal(stripTilPrefix("TIL - foo"), "foo");
  assert.equal(stripTilPrefix("Til – foo"), "foo");
  assert.equal(stripTilPrefix("TIL:\nfoo\nbar"), "foo\nbar");
});

test("stripTilPrefix leaves everything else alone", () => {
  assert.equal(stripTilPrefix("TIL"), null);
  assert.equal(stripTilPrefix("TIL:"), null);
  assert.equal(stripTilPrefix("tilde is a key"), null);
  assert.equal(stripTilPrefix("until then"), null);
  assert.equal(stripTilPrefix("today TIL foo"), null);
  assert.equal(stripTilPrefix(""), null);
});

test("stripTilPrefix takes a dash run with or without spaces", () => {
  assert.equal(stripTilPrefix("TIL-foo"), "foo");
  assert.equal(stripTilPrefix("TIL--foo"), "foo");
  assert.equal(stripTilPrefix("TIL—foo"), "foo");
  assert.equal(stripTilPrefix("TIL –foo"), "foo");
});

test("stripTilPrefix needs text after the marker", () => {
  for (const text of ["TIL ", "TIL   ", "TIL: ", "TIL\n", "TIL:\n\n"])
    assert.equal(stripTilPrefix(text), null, JSON.stringify(text));
});

test("stripTilPrefix ignores a marker followed only by dashes or punctuation", () => {
  for (const text of ["TIL -", "TIL —", "TIL - -", "TIL: ...", "TIL -\n"])
    assert.equal(stripTilPrefix(text), null, JSON.stringify(text));
  assert.equal(stripTilPrefix("TIL - 5 things"), "5 things");
});

test("stripTilPrefix takes any whitespace run between the marker and the text", () => {
  assert.equal(stripTilPrefix("TIL\nfoo"), "foo");
  assert.equal(stripTilPrefix("TIL\n\n\nfoo"), "foo");
  assert.equal(stripTilPrefix("TIL:\r\nfoo\r\nbar"), "foo\r\nbar");
  assert.equal(stripTilPrefix("TIL\tfoo"), "foo");
});

test("stripTilPrefix ignores the marker's case, keeps the rest, and strips only once", () => {
  assert.equal(stripTilPrefix("tIl foo"), "foo");
  assert.equal(stripTilPrefix("Til: foo"), "foo");
  assert.equal(stripTilPrefix("TIL: Foo"), "Foo");
  assert.equal(stripTilPrefix("TIL TIL foo"), "TIL foo");
});

test("stripTilPrefix rejects words that only start with til and other punctuation", () => {
  for (const text of [
    "tilt the camera",
    "tills",
    "TILL noon",
    "till noon",
    "til.e foo",
    "TIL/foo",
    "TIL, foo",
    "TIL! foo",
    "TIL; foo",
    "TIL. foo",
    "TIL… foo",
  ])
    assert.equal(stripTilPrefix(text), null, text);
});

test("known limitation: the English word 'til' is read as the marker", () => {
  assert.equal(stripTilPrefix("til noon I slept"), "noon I slept");
  assert.equal(stripTilPrefix("til 5pm"), "5pm");
  assert.equal(stripTilPrefix("Til tomorrow: call mom"), "tomorrow: call mom");
});

test("stripJournalLine strips the time prefix and anchor suffix", () => {
  assert.equal(
    stripJournalLine("- _23:13:18 ::_ hi ^a1b2c3d4", "23:13:18"),
    "hi",
  );
  // A caret inside the text isn't an anchor: journalLine always writes " ^id" at the end.
  assert.equal(stripJournalLine("- _23:13:18 ::_ 3^2", "23:13:18"), "3^2");
});
