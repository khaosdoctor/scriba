import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "./page.ts";

test("paginate clamps a page past either end to the nearest real page", () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(paginate(items, 99, 2), {
    items: [5],
    page: 2,
    pages: 3,
    offset: 4,
  });
  assert.equal(paginate(items, -4, 2).page, 0);
});

test("paginate of an empty list is one empty page", () => {
  assert.deepEqual(paginate([], 3, 8), {
    items: [],
    page: 0,
    pages: 1,
    offset: 0,
  });
});
