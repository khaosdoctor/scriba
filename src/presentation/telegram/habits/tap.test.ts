import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprint } from "../../../libs/text.ts";
import { botHarness } from "../../../test/bot-harness.ts";

const DAY = "2026-08-15";
const NOTE = `## Habits\n- [ ] Practiced music #meta/habits/music\n- [ ] [Pages read:: 0] #meta/habits/reading\n`;
const MUSIC = fingerprint("- [ ] Practiced music #meta/habits/music");

const withNote = async () => {
  const harness = await botHarness();
  harness.obsidian.readDailyNote = { path: "p.md", content: NOTE };
  harness.obsidian.readNote = NOTE;
  return harness;
};

test("Begin edits the tapped card into the first pending question, even after a restart lost the prompt", async () => {
  const harness = await withNote();
  const run = await harness.tap(`hb:${DAY}:begin`, {
    message: { message_id: 321 },
  });
  const edit = run.calls.find((call) => call.method === "editMessageText");
  assert.equal(edit?.payload.message_id, 321);
  assert.equal(edit?.payload.text, "🌱 Practiced music?");
});

test("Yes ticks the habit, answers the tap, and edits the card into the next question", async () => {
  const harness = await withNote();
  await harness.tap(`hb:${DAY}:begin`);
  const run = await harness.tap(`hb:${DAY}:0:${MUSIC}:y`);
  assert.deepEqual(run.texts("answerCallbackQuery"), [undefined]);
  assert.match(run.texts("editMessageText")[0] ?? "", /^🌱 Pages read\?/);
});

test("a payload with a bad date, a non-numeric index or no line digest is refused before any note is read", async () => {
  for (const data of [
    "hb:",
    "hb:2026-7-5:0:y",
    "hb:2026-02-31:0:y",
    `hb:${DAY}:x:y`,
    `hb:${DAY}`,
    `hb:${DAY}:0`,
  ]) {
    const harness = await botHarness();
    const run = await harness.tap(data);
    assert.equal(run.rendered, "ack(bad habit)", data);
  }
});
