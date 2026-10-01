import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatJotDetail,
  jotPreview,
  parseEntrySize,
  parseWizardRef,
  previewList,
  ratingDay,
  WIZARD_ENTRYSIZE_REF,
  WIZARD_NOTE_REF,
  WIZARD_RATING_TIME_REF,
  WIZARD_REGISTER_REF,
  WIZARD_STOPWORD_REF,
} from "./core.ts";
import type { Jot } from "./models/domain.ts";

test("parseEntrySize validates a typed entry size", () => {
  assert.equal(parseEntrySize("280"), 280);
  assert.equal(parseEntrySize(" off "), 0);
  assert.equal(parseEntrySize("0"), 0);
  assert.equal(parseEntrySize("10"), null); // no sentence fits
  assert.equal(parseEntrySize("99999"), null);
  assert.equal(parseEntrySize("lots"), null);
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

test("previewList counts what it leaves out instead of cutting silently", () => {
  assert.equal(previewList(["a", "b"], 5), "a, b");
  assert.equal(previewList([], 5), "");
  assert.equal(previewList(["a", "b", "c", "d"], 2), "a, b … +2 more");
});
