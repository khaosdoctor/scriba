import assert from "node:assert/strict";
import { test } from "node:test";
import { withDb } from "../../test/sqlite.ts";
import { SettingsRepository } from "./settings.ts";

test("settings: a write replaces the stored value and reads back typed", async (t) => {
  await withDb(t, async (k) => {
    const settings = new SettingsRepository(k);
    assert.equal(await settings.getSetting("entryMaxChars"), 280);
    await settings.setSetting("entryMaxChars", "140");
    assert.equal(await settings.getSetting("entryMaxChars"), 140);
    await settings.setSetting("entryMaxChars", "0"); // merge on conflict
    assert.equal(await settings.getSetting("entryMaxChars"), 0);
  });
});

test("settings: toggle turns a switch on or off from its default and persists the string", async (t) => {
  await withDb(t, async (k) => {
    const settings = new SettingsRepository(k);
    assert.equal(await settings.toggleSetting("nightlyRating"), false);
    assert.equal(await settings.getSetting("nightlyRating"), false);
    assert.equal(await settings.toggleSetting("nightlyRating"), true);
    assert.equal(await settings.getSetting("nightlyRating"), true);
    assert.equal(await settings.toggleSetting("fixVoiceTranscript"), true);
    const stored = await k("settings")
      .where({ key: "fixVoiceTranscript" })
      .first();
    assert.equal(stored.value, "on");
  });
});

test("settings: seeding writes only unset or blank keys", async (t) => {
  await withDb(t, async (k) => {
    const settings = new SettingsRepository(k);
    await settings.setSetting("voiceFixModel", "");
    await settings.setSetting("enrichModel", "chosen-in-menu");
    await settings.seedSettings({
      enrichModel: "from-config",
      voiceFixModel: "voice-from-config",
    });
    assert.equal(await settings.getSetting("enrichModel"), "chosen-in-menu");
    assert.equal(
      await settings.getSetting("voiceFixModel"),
      "voice-from-config",
    );
  });
});

test("settings: the rating time is the stored time when valid, else the normalised default", async (t) => {
  await withDb(t, async (k) => {
    const settings = new SettingsRepository(k);
    assert.equal(await settings.ratingTime("00:00"), "00:00");
    assert.equal(await settings.ratingTime("9:30"), "09:30");
    await settings.setSetting("ratingTime", "8:05");
    assert.equal(await settings.ratingTime("00:00"), "08:05");
    await settings.setSetting("ratingTime", "garbage");
    assert.equal(await settings.ratingTime("21:00"), "21:00");
    assert.equal(await settings.ratingTime("9:30"), "09:30");
  });
});
