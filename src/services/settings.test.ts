import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeSettings } from "../test/fakes.ts";
import { SettingsService } from "./settings.ts";

function setup(stored: Record<string, string> = {}) {
  const events: string[] = [];
  const sent: { text: string; opts: any }[] = [];
  const settings = new SettingsService({
    settings: new FakeSettings(stored, (key, value) =>
      events.push(`set ${key}=${value}`),
    ) as never,
    linkRules: {} as never,
    links: {
      list: () => [],
      stats: () => ({ enabled: true, aliases: 0, files: 0 }),
    },
    enricher: { setModel: (model) => void events.push(`enricher ${model}`) },
    scheduler: { rearm: async (name) => void events.push(`rearm ${name}`) },
    notifier: {
      send: async (text, opts) => {
        sent.push({ text, opts });
        return 50;
      },
    },
    ratingTime: "00:00",
  });
  return { settings, events, sent };
}

test("changing the enrichment model tells the enricher; the voice-fix model is only stored", async () => {
  const { settings, events } = setup();
  await settings.setModel("enrichModel", "claude-opus-5");
  await settings.setModel("voiceFixModel", "claude-haiku-4-5");
  assert.deepEqual(events, [
    "set enrichModel=claude-opus-5",
    "enricher claude-opus-5",
    "set voiceFixModel=claude-haiku-4-5",
  ]);
});

test("a new rating time is stored before the nightly job is re-armed", async () => {
  const { settings, events } = setup();
  await settings.setRatingTime("23:30");
  assert.deepEqual(events, ["set ratingTime=23:30", "rearm rating"]);
});
