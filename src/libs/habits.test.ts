import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHabitRef } from "./habits.ts";

test("parseHabitRef extracts the day, index and line digest from a question, or null", () => {
  assert.deepEqual(
    parseHabitRef(
      "🌱 Pages read? Reply with a value.\n(hb:2026-06-22:1:4abbc816)",
    ),
    {
      date: "2026-06-22",
      index: 1,
      digest: "4abbc816",
    },
  );
  assert.equal(parseHabitRef("(hb:2026-06-22:1)"), null);
  assert.equal(parseHabitRef("just a normal edit reply"), null);
});
