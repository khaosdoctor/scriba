import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseWizardRef,
  WIZARD_ENTRYSIZE_REF,
  WIZARD_NOTE_REF,
  WIZARD_RATING_TIME_REF,
  WIZARD_REGISTER_REF,
  WIZARD_STOPWORD_REF,
} from "./wizard.ts";

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
