import assert from "node:assert/strict";
import { test } from "node:test";
import {
	dateFromIso,
	dayBounds,
	msUntilNext,
	plainDate,
	plainTime,
	previousDate,
	startOfToday,
} from "./time.ts";

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

test("startOfToday zeroes the clock and is idempotent", () => {
	const now = 1_700_000_000_000;
	const start = startOfToday(now);
	assert.ok(start <= now && now - start < 24 * 60 * 60_000);
	assert.equal(startOfToday(start), start); // already midnight → unchanged
	assert.equal(new Date(start).getSeconds(), 0);
	assert.equal(new Date(start).getMilliseconds(), 0);
});

test("previousDate is the calendar day before", () => {
	const now = 1_700_000_000_000;
	assert.equal(previousDate(now), plainDate(startOfToday(now) - 1));
});

test("dateFromIso is the inverse of plainDate and rejects malformed input", () => {
	const epochMs = 1_700_000_000_000;
	assert.equal(
		plainDate(dateFromIso(plainDate(epochMs)).getTime()),
		plainDate(epochMs),
	);
	assert.throws(() => dateFromIso("not-a-date"));
	assert.throws(() => dateFromIso("2026-7-10")); // not zero-padded
	assert.throws(() => dateFromIso(""));
});

test("dayBounds spans [local midnight, next local midnight)", () => {
	// Not asserting a fixed 24h delta here — that's not true on a DST transition day
	// (see the dedicated DST test below), and would push the implementation the wrong way.
	const [from, to] = dayBounds("2026-07-10");
	assert.equal(plainDate(from), "2026-07-10");
	assert.equal(plainDate(to), "2026-07-11"); // exclusive end, next day's midnight
	assert.equal(new Date(from).getHours(), 0);
	assert.equal(new Date(to).getHours(), 0);
	assert.ok(to > from);
});

test("dayBounds rejects a sub-1000 year (JS Date's 0-99-is-1900+ special case)", () => {
	assert.throws(() => dayBounds("0099-01-01"));
	assert.throws(() => dayBounds("0000-01-01"));
});

test("dayBounds spans a short/long day across a DST transition, not a fixed 24h", () => {
	const prevTZ = process.env.TZ;
	process.env.TZ = "America/New_York";
	try {
		// US spring-forward 2026: clocks skip 2am -> 3am, so this local day is 23h.
		const [springFrom, springTo] = dayBounds("2026-03-08");
		assert.equal(springTo - springFrom, 23 * 60 * 60_000);
		// US fall-back 2026: 1am repeats, so this local day is 25h.
		const [fallFrom, fallTo] = dayBounds("2026-11-01");
		assert.equal(fallTo - fallFrom, 25 * 60 * 60_000);
	} finally {
		// process.env.TZ = undefined would coerce to the string "undefined" and leave TZ
		// set for later tests — delete the key outright when it wasn't originally set.
		if (prevTZ === undefined) delete process.env.TZ;
		else process.env.TZ = prevTZ;
	}
});
