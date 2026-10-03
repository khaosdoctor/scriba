import assert from "node:assert/strict";
import { test } from "node:test";
import { followupRef, parseFollowupRef } from "./followup.ts";
import { parseHabitRef } from "./habits.ts";
import { parseWizardRef } from "./wizard.ts";

test("followupRef round-trips through parseFollowupRef", () => {
  for (const question of ["journal", "til"] as const) {
    const text = `Learned anything today? Reply to this message.\n${followupRef(question, "2026-07-05")}`;
    assert.deepEqual(parseFollowupRef(text), {
      question,
      date: "2026-07-05",
    });
  }
  assert.equal(parseFollowupRef("(fu:x:2026-07-05)"), null);
  assert.equal(parseFollowupRef("(hb:2026-07-05:1)"), null);
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
