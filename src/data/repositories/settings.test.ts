import assert from "node:assert/strict";
import { test } from "node:test";
import { withDb } from "../../test/sqlite.ts";
import { SettingsRepository } from "./settings.ts";

test("settings: a write replaces the stored value and reads back typed", async (t) => {
  await withDb(t, async (k) => {
    const settings = new SettingsRepository(k);
    assert.equal(await settings.get("entryMaxChars"), 280);
    await settings.set("entryMaxChars", "140");
    assert.equal(await settings.get("entryMaxChars"), 140);
    await settings.set("entryMaxChars", "0"); // merge on conflict
    assert.equal(await settings.get("entryMaxChars"), 0);
  });
});

test("settings: toggle turns a switch on or off from its default and persists the string", async (t) => {
  await withDb(t, async (k) => {
    const settings = new SettingsRepository(k);
    assert.equal(await settings.toggle("nightlyRating"), false);
    assert.equal(await settings.get("nightlyRating"), false);
    assert.equal(await settings.toggle("nightlyRating"), true);
    assert.equal(await settings.get("nightlyRating"), true);
    assert.equal(await settings.toggle("fixVoiceTranscript"), true);
    const stored = await k("settings")
      .where({ key: "fixVoiceTranscript" })
      .first();
    assert.equal(stored.value, "on");
  });
});

test("settings: seeding writes only unset or blank keys", async (t) => {
  await withDb(t, async (k) => {
    const settings = new SettingsRepository(k);
    await settings.set("voiceFixModel", "");
    await settings.set("enrichModel", "chosen-in-menu");
    await settings.seedDefaults({
      enrichModel: "from-config",
      voiceFixModel: "voice-from-config",
    });
    assert.equal(await settings.get("enrichModel"), "chosen-in-menu");
    assert.equal(await settings.get("voiceFixModel"), "voice-from-config");
  });
});

test("settings: the rating time is the stored time when valid, else the normalised default", async (t) => {
  await withDb(t, async (k) => {
    const settings = new SettingsRepository(k);
    assert.equal(await settings.ratingTime("00:00"), "00:00");
    assert.equal(await settings.ratingTime("9:30"), "09:30");
    await settings.set("ratingTime", "8:05");
    assert.equal(await settings.ratingTime("00:00"), "08:05");
    await settings.set("ratingTime", "garbage");
    assert.equal(await settings.ratingTime("21:00"), "21:00");
    assert.equal(await settings.ratingTime("9:30"), "09:30");
  });
});
