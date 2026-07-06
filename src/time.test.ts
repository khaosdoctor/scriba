import { test } from "node:test";
import assert from "node:assert/strict";
import { plainTime, plainDate, msUntilNext } from "./time.ts";

test("plainDate/plainTime return well-formed strings", () => {
  assert.match(plainDate(0), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(plainTime(0), /^\d{2}:\d{2}:\d{2}$/);
  assert.match(plainDate(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(plainTime(), /^\d{2}:\d{2}:\d{2}$/);
});

test("plainTime is stable for a fixed instant", () => {
  // same epoch → same value (whatever the host TZ is)
  assert.equal(plainTime(1_700_000_000_000), plainTime(1_700_000_000_000));
  assert.equal(plainDate(1_700_000_000_000), plainDate(1_700_000_000_000));
});

test("msUntilNext returns a positive delay within 24h", () => {
  const ms = msUntilNext("23:30");
  assert.ok(ms > 0 && ms <= 24 * 60 * 60_000, `got ${ms}`);
});
