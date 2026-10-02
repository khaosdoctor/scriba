import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS } from "./entity.ts";

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
