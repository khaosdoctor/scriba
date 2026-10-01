import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ENTRY_MAX_CHARS,
  entryMaxChars,
  IsoDateSchema,
  parseClockTime,
  ratingTime,
  switchEnabled,
  voiceFixEnabled,
} from "./settings.ts";

test("IsoDateSchema rejects malformed shapes, sub-100 years, and out-of-range month/day", () => {
  const ok = (d: string) => IsoDateSchema.safeParse(d).success;
  assert.equal(ok("2026-07-10"), true);
  assert.equal(ok("2024-02-29"), true); // 2024 is a leap year
  assert.equal(ok("0500-01-01"), true); // outside Date's 0-99 special case
  assert.equal(ok("not-a-date"), false);
  assert.equal(ok("2026-7-10"), false); // not zero-padded
  assert.equal(ok("0099-01-01"), false); // Date's 1900+ special case
  assert.equal(ok("2026-99-99"), false); // out-of-range month/day
  assert.equal(ok("2026-13-01"), false); // month 13 doesn't exist
  assert.equal(ok("2026-02-30"), false); // Feb never has a 30th
  assert.equal(ok("2026-02-29"), false); // 2026 is not a leap year
});

test("parseClockTime takes valid 24h times, trims, and pads the hour", () => {
  for (const [input, out] of [
    ["0:00", "00:00"],
    ["00:59", "00:59"],
    ["19:05", "19:05"],
    ["23:00", "23:00"],
    ["1:00", "01:00"],
    [" 23:59 ", "23:59"],
  ] as const)
    assert.equal(parseClockTime(input), out, input);
});

test("parseClockTime rejects malformed, non-ASCII and multi-line input", () => {
  for (const bad of [
    "24:00",
    "2:60",
    "12:60",
    "-1:00",
    "1:2:3",
    "12:00:00",
    "12.30",
    "12:5",
    "1230",
    "１２:３０",
    "12:30pm",
    "12:30\n13:00",
    "",
    " ",
    "\t",
    ":30",
    "12:",
    "7pm",
    "abc",
    "🕛",
    "12",
    "ab:cd",
  ])
    assert.equal(parseClockTime(bad), null, JSON.stringify(bad));
});

test("entryMaxChars falls back to the default and treats 0 as off", () => {
  assert.equal(entryMaxChars(undefined), DEFAULT_ENTRY_MAX_CHARS);
  assert.equal(entryMaxChars(""), DEFAULT_ENTRY_MAX_CHARS);
  assert.equal(entryMaxChars("nonsense"), DEFAULT_ENTRY_MAX_CHARS);
  assert.equal(entryMaxChars("-5"), DEFAULT_ENTRY_MAX_CHARS);
  assert.equal(entryMaxChars("0"), 0);
  assert.equal(entryMaxChars("140"), 140);
});

test("voice fix is opt-in and every switch is on unless explicitly off", () => {
  assert.equal(voiceFixEnabled(undefined), false);
  assert.equal(voiceFixEnabled("off"), false);
  assert.equal(voiceFixEnabled("on"), true);
  assert.equal(switchEnabled(undefined), true);
  assert.equal(switchEnabled("on"), true);
  assert.equal(switchEnabled("off"), false);
});

test("ratingTime uses the stored time when valid, else the normalised default", () => {
  assert.equal(ratingTime("22:15", "00:00"), "22:15");
  assert.equal(ratingTime("8:05", "00:00"), "08:05");
  assert.equal(ratingTime(undefined, "00:00"), "00:00");
  assert.equal(ratingTime("garbage", "21:00"), "21:00");
  assert.equal(ratingTime(undefined, "9:30"), "09:30");
  assert.equal(ratingTime("garbage", "9:30"), "09:30");
});
