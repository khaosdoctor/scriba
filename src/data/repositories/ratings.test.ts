import assert from "node:assert/strict";
import { test } from "node:test";
import { withDb } from "../../test/sqlite.ts";
import { RatingRepository } from "./ratings.ts";

test("a day's rating is write-once: the first record wins", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const ratings = new RatingRepository(knex);
    // write-once: first record wins, second is rejected with the existing value
    assert.deepEqual(await ratings.recordRating("2026-07-06", 8), {
      recorded: true,
      current: 8,
    });
    assert.deepEqual(await ratings.recordRating("2026-07-06", 3), {
      recorded: false,
      current: 8,
    });
    await ratings.clearRating("2026-07-06");
    assert.deepEqual(await ratings.recordRating("2026-07-06", 3), {
      recorded: true,
      current: 3,
    });
  });
});
