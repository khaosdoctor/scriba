import assert from "node:assert/strict";
import { test } from "node:test";
import { RatingSchema } from "./entity.ts";

test("RatingSchema takes button text for a whole number from 1 to 10", () => {
  for (const ok of ["1", "7", "10"])
    assert.equal(RatingSchema.safeParse(ok).success, true, ok);
  for (const bad of ["0", "11", "5.5", "", "x", " ", "-1", "Infinity"])
    assert.equal(RatingSchema.safeParse(bad).success, false, bad);
  assert.equal(RatingSchema.safeParse(undefined).success, false);
});
