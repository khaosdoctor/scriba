import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IsoDateSchema,
  parseClockTime,
  RatingSchema,
  SETTINGS,
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

test("entryMaxChars falls back to 280 and treats 0 as off", () => {
  const parse = SETTINGS.entryMaxChars.parse;
  assert.equal(parse(undefined), 280);
  assert.equal(parse(""), 280);
  assert.equal(parse("nonsense"), 280);
  assert.equal(parse("-5"), 280);
  assert.equal(parse("0"), 0);
  assert.equal(parse("140"), 140);
});

test("voice fix is opt-in and every other switch is on unless explicitly off", () => {
  const voiceFix = SETTINGS.fixVoiceTranscript.parse;
  assert.equal(voiceFix(undefined), false);
  assert.equal(voiceFix("off"), false);
  assert.equal(voiceFix("on"), true);
  for (const key of [
    "nightlyRating",
    "nightlyFollowup",
    "taskDetection",
    "tilDetection",
  ] as const) {
    assert.equal(SETTINGS[key].parse(undefined), true, key);
    assert.equal(SETTINGS[key].parse("on"), true, key);
    assert.equal(SETTINGS[key].parse("off"), false, key);
  }
});

test("a stored rating time is normalised, and an unusable one reads as unset", () => {
  const parse = SETTINGS.ratingTime.parse;
  assert.equal(parse("22:15"), "22:15");
  assert.equal(parse("8:05"), "08:05");
  assert.equal(parse(undefined), undefined);
  assert.equal(parse("garbage"), undefined);
});

test("a switch toast names the state it was just set to", () => {
  assert.equal(SETTINGS.fixVoiceTranscript.label(true), "Voice fix on");
  assert.equal(SETTINGS.nightlyRating.label(false), "Nightly rating off");
  assert.equal(SETTINGS.nightlyFollowup.label(false), "Follow-up off");
  assert.equal(
    SETTINGS.taskDetection.label(false),
    "I'll stop suggesting tasks",
  );
  assert.equal(SETTINGS.tilDetection.label(true), "I'll suggest TILs again");
});

test("RatingSchema takes button text for a whole number from 1 to 10", () => {
  for (const ok of ["1", "7", "10"])
    assert.equal(RatingSchema.safeParse(ok).success, true, ok);
  for (const bad of ["0", "11", "5.5", "", "x", " ", "-1", "Infinity"])
    assert.equal(RatingSchema.safeParse(bad).success, false, bad);
  assert.equal(RatingSchema.safeParse(undefined).success, false);
});
