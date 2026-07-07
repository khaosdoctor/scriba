import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeJotId, journalLine, placeholderLine, replaceAnchorLine, deleteAnchorLine,
  anchorLine, candidates, candidateTerms, candidatesViaSearch, parseLiteralEdit, tokenize,
  insertJournalLine,
} from "./core.ts";

const STOP = new Set(["no", "we", "i", "on", "e", "de"]);

test("ids are fixed 8-char hex", () => {
  const id = makeJotId();
  assert.match(id, /^[0-9a-f]{8}$/);
});

test("journal + placeholder lines match the vault house style", () => {
  assert.equal(journalLine("23:13:18", "hi", "a1b2c3d4"), "- _23:13:18 ::_ hi ^a1b2c3d4");
  assert.equal(placeholderLine("09:00:00", "deadbeef"), "- _09:00:00 ::_ ⏳ ^deadbeef");
});

test("insertJournalLine replaces the empty template bullet on the first jot", () => {
  const note = "# 2026-07-07\n\n## Journal\n- \n";
  const out = insertJournalLine(note, "Journal", "- _19:56:31 ::_ ⏳ ^23c78f08");
  assert.equal(out, "# 2026-07-07\n\n## Journal\n- _19:56:31 ::_ ⏳ ^23c78f08\n");
});

test("insertJournalLine appends right after the last bullet, no blank line", () => {
  const note = "## Journal\n- _19:56:31 ::_ first ^aaaaaaaa\n";
  const out = insertJournalLine(note, "Journal", "- _19:57:00 ::_ ⏳ ^bbbbbbbb");
  assert.equal(out, "## Journal\n- _19:56:31 ::_ first ^aaaaaaaa\n- _19:57:00 ::_ ⏳ ^bbbbbbbb\n");
});

test("insertJournalLine stays within the section, before the next heading", () => {
  const note = "## Journal\n- _10:00:00 ::_ a ^aaaaaaaa\n\n## Notes\n- keep\n";
  const out = insertJournalLine(note, "Journal", "- _10:01:00 ::_ ⏳ ^bbbbbbbb");
  assert.equal(
    out,
    "## Journal\n- _10:00:00 ::_ a ^aaaaaaaa\n- _10:01:00 ::_ ⏳ ^bbbbbbbb\n\n## Notes\n- keep\n",
  );
});

test("insertJournalLine inserts right after the heading when the section is empty", () => {
  const note = "## Journal\n";
  const out = insertJournalLine(note, "Journal", "- _10:00:00 ::_ ⏳ ^aaaaaaaa");
  assert.equal(out, "## Journal\n- _10:00:00 ::_ ⏳ ^aaaaaaaa\n");
});

test("replace/delete/read find the line by anchor and leave others intact", () => {
  const note = [
    "## Journal",
    "- _10:00:00 ::_ first ^aaaaaaaa",
    "- _10:01:00 ::_ ⏳ ^bbbbbbbb",
    "- _10:02:00 ::_ third ^cccccccc",
  ].join("\n");
  const replaced = replaceAnchorLine(note, "bbbbbbbb", "- _10:01:00 ::_ enriched ^bbbbbbbb");
  assert.ok(replaced?.includes("enriched ^bbbbbbbb"));
  assert.ok(replaced?.includes("first ^aaaaaaaa"));
  assert.ok(!replaced?.includes("⏳"));
  assert.equal(replaceAnchorLine(note, "ffffffff", "x"), null);
  assert.equal(anchorLine(note, "cccccccc"), "- _10:02:00 ::_ third ^cccccccc");

  const deleted = deleteAnchorLine(note, "aaaaaaaa");
  assert.ok(!deleted?.includes("aaaaaaaa"));
  assert.ok(deleted?.includes("cccccccc"));
});

test("candidates drop stopwords/short aliases and honour rejections", () => {
  const index = [
    { note: "Norway", alias: "no" },        // stopword → dropped
    { note: "Norway", alias: "Norway" },    // real → kept
    { note: "We (novel)", alias: "We" },    // 2 chars → dropped
    { note: "Fume Extractor", alias: "Fume Extractor" }, // multiword → kept
    { note: "Lev", alias: "Lev" },
  ];
  const text = "I said no to visiting Norway but fixed the Fume Extractor for Lev";
  const got = candidates(text, index, STOP, new Set());
  assert.deepEqual(got.map((c) => c.note).sort(), ["Fume Extractor", "Lev", "Norway"]);

  const rejected = new Set(["lev Lev"]); // user previously said no to Lev
  const got2 = candidates(text, index, STOP, rejected);
  assert.ok(!got2.some((c) => c.note === "Lev"));
});

test("candidateTerms keeps distinct >=3-char non-stopwords", () => {
  assert.deepEqual(candidateTerms("I said no to Norway and Norway again", STOP), ["said", "norway", "and", "again"]);
});

test("candidatesViaSearch searches each term, honours rejections, dedupes", async () => {
  const vault: Record<string, string[]> = { norway: ["Norway"], therapy: ["Therapy Topics", "Therapy Topics"] };
  const search = async (t: string) => vault[t] ?? [];
  const got = await candidatesViaSearch("visiting Norway for therapy", search, STOP, new Set());
  assert.deepEqual(got, [{ surface: "norway", note: "Norway" }, { surface: "therapy", note: "Therapy Topics" }]);

  const rejected = new Set(["norway Norway"]);
  const got2 = await candidatesViaSearch("visiting Norway for therapy", search, STOP, rejected);
  assert.deepEqual(got2.map((c) => c.note), ["Therapy Topics"]);
});

test("candidatesViaSearch swallows a failing search and continues", async () => {
  const search = async (t: string) => { if (t === "boom") throw new Error("rest down"); return ["Fine"]; };
  const got = await candidatesViaSearch("boom fine", search, STOP, new Set());
  assert.deepEqual(got, [{ surface: "fine", note: "Fine" }]);
});

test("candidatesViaSearch drops substring title hits, keeps whole-word matches", async () => {
  const search = async (_t: string) => ["Test Leads", "The problem with E2E tests", "fastest boat"];
  const got = await candidatesViaSearch("test", search, STOP, new Set());
  assert.deepEqual(got, [{ surface: "test", note: "Test Leads" }]); // "tests"/"fastest" are substrings, not words
});

test("literal edit parser handles sed and natural forms, rejects freeform", () => {
  assert.deepEqual(parseLiteralEdit("s/pot/potentiometer/"), { old: "pot", new: "potentiometer" });
  assert.deepEqual(parseLiteralEdit("replace pot with potentiometer"), { old: "pot", new: "potentiometer" });
  assert.deepEqual(parseLiteralEdit('replace "the cat" with "the dog"'), { old: "the cat", new: "the dog" });
  assert.equal(parseLiteralEdit("make this clearer"), null);
});

test("tokenize keeps accented letters", () => {
  assert.deepEqual(tokenize("Não é fácil"), ["não", "é", "fácil"]);
});
