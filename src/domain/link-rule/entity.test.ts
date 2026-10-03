import assert from "node:assert/strict";
import { test } from "node:test";
import { linkRuleKey, notesFor } from "./entity.ts";

test("a link rule's key is its surface and note joined by one space", () => {
  assert.equal(linkRuleKey("go", "Go (language)"), "go Go (language)");
});

test("the notes for a surface come back in list order, matching the surface exactly", () => {
  const rules = [
    { surface: "go", note: "Go (language)" },
    { surface: "rust", note: "Rust" },
    { surface: "go", note: "Go (game)" },
    { surface: "Go", note: "Capitalised" },
    { surface: " go", note: "Padded" },
  ];
  assert.deepEqual(notesFor(rules, "go"), ["Go (language)", "Go (game)"]);
  assert.deepEqual(notesFor(rules, "python"), []);
});
