import assert from "node:assert/strict";
import { test } from "node:test";
import { withDb } from "../test/sqlite.ts";
import { SettingsRepository } from "./settings.ts";

test("settings: upsert + read", async (t) => {
  await withDb(t, async (k) => {
    const settings = new SettingsRepository(k);
    assert.equal(await settings.getSetting("transcriber"), undefined);
    await settings.setSetting("transcriber", "remote");
    assert.equal(await settings.getSetting("transcriber"), "remote");
    await settings.setSetting("transcriber", "local"); // merge on conflict
    assert.equal(await settings.getSetting("transcriber"), "local");
  });
});
