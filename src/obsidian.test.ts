import { test } from "node:test";
import assert from "node:assert/strict";
import { headingTarget } from "./obsidian.ts";

test("headingTarget builds the full ancestor path (leaf alone returns 40080 invalid-target)", () => {
  assert.equal(headingTarget("2026-07-07", "Journal"), "2026-07-07::Journal");
});

test("headingTarget URL-encodes each segment but keeps the :: delimiter literal", () => {
  assert.equal(headingTarget("2026-07-07", "Daily Log"), "2026-07-07::Daily%20Log");
});
