import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidates,
  cleanNoteTitle,
  distinctSurfaces,
  forcedCandidates,
  isEmbeddableUrl,
  linkDateWords,
  noteSuggestions,
  parseAliasEntries,
  parseRuleWords,
  tokenize,
  unlinkWikilinks,
} from "./links.ts";

test("unlinkWikilinks puts back the shown words of every wikilink", () => {
  assert.equal(
    unlinkWikilinks(
      "Emailed Alex [[2026-01-15|today]] about [[Acme]] and [[notes/Globex|Globex]].",
    ),
    "Emailed Alex today about Acme and Globex.",
  );
  assert.equal(unlinkWikilinks("no links here"), "no links here");
});

const STOP = new Set(["no", "we", "i", "on", "e", "de"]);

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
  assert.deepEqual(got.map((candidate) => candidate.note).sort(), [
    "Fume Extractor",
    "Lev",
    "Norway",
  ]);

  const rejected = new Set(["lev Lev"]); // user previously said no to Lev
  const got2 = candidates(text, index, STOP, rejected);
  assert.ok(!got2.some((candidate) => candidate.note === "Lev"));
});

test("forcedCandidates: matches registered surface->note pairs, ignoring length/stopword rules, marked forced", () => {
  const registered = [
    { surface: "no", note: "Norway" }, // 2 chars + a stopword elsewhere, still forced
    { surface: "Fume Extractor", note: "Fume Extractor" }, // multiword
    { surface: "gym", note: "Fitness" },
  ];
  const text = "said no to visiting the Fume Extractor room";
  const got = forcedCandidates(text, registered);
  assert.deepEqual(
    got
      .map((candidate) => [candidate.surface, candidate.note, candidate.forced])
      .sort(),
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

test("tokenize keeps accented letters", () => {
  assert.deepEqual(tokenize("Não é fácil"), ["não", "é", "fácil"]);
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

test("parseAliasEntries always yields the title, then inline or block aliases unquoted", () => {
  assert.deepEqual(parseAliasEntries("/v/Plain.md", "no frontmatter"), [
    { note: "Plain", alias: "Plain" },
  ]);
  assert.deepEqual(
    parseAliasEntries(
      "/v/Norway.md",
      "---\naliases: [no, 'Noruega']\n---\nbody",
    ),
    [
      { note: "Norway", alias: "Norway" },
      { note: "Norway", alias: "no" },
      { note: "Norway", alias: "Noruega" },
    ],
  );
  assert.deepEqual(
    parseAliasEntries(
      "/v/Fume.md",
      '---\naliases:\n  - Extractor\n  - "Hood"\n---\n',
    ),
    [
      { note: "Fume", alias: "Fume" },
      { note: "Fume", alias: "Extractor" },
      { note: "Fume", alias: "Hood" },
    ],
  );
  assert.deepEqual(
    parseAliasEntries("/v/Empty.md", "---\naliases: []\n---\n"),
    [{ note: "Empty", alias: "Empty" }],
  );
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
