import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeJotId, journalLine, placeholderLine, replaceAnchorLine, deleteAnchorLine,
  anchorLine, candidates, parseLiteralEdit, tokenize,
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

test("literal edit parser handles sed and natural forms, rejects freeform", () => {
  assert.deepEqual(parseLiteralEdit("s/pot/potentiometer/"), { old: "pot", new: "potentiometer" });
  assert.deepEqual(parseLiteralEdit("replace pot with potentiometer"), { old: "pot", new: "potentiometer" });
  assert.deepEqual(parseLiteralEdit('replace "the cat" with "the dog"'), { old: "the cat", new: "the dog" });
  assert.equal(parseLiteralEdit("make this clearer"), null);
});

test("tokenize keeps accented letters", () => {
  assert.deepEqual(tokenize("Não é fácil"), ["não", "é", "fácil"]);
});
