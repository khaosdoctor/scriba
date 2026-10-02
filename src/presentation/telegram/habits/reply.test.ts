import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprint } from "../../../libs/tasks.ts";
import { botHarness } from "../../../test/bot-harness.ts";

const DAY = "2026-08-15";
const NOTE = `## Habits\n- [ ] Practiced music #meta/habits/music\n- [ ] [Pages read:: 0] #meta/habits/reading\n`;
const PAGES = fingerprint("- [ ] [Pages read:: 0] #meta/habits/reading");
const QUESTION = `🌱 Pages read? Reply to this message with a number.\n(hb:${DAY}:1:${PAGES})`;

const RECORD =
  "obsidian.readDailyNote > obsidian.updateNote > obsidian.readNote > obsidian.writeNote";
// No habit is left after the answered one, so the review stamps the note and ends.
const NEXT =
  "obsidian.readDailyNote > obsidian.setFrontmatter > obsidian.readNote > obsidian.writeNote";

const answer = async (text: string, note: string | null = NOTE) => {
  const harness = await botHarness();
  if (note) {
    harness.obsidian.readDailyNote = { path: "p.md", content: note };
    harness.obsidian.readNote = note;
  }
  return harness.say(text, { message_id: 7, text: QUESTION });
};

test("a number answers the question: it is recorded, the reply leaves the chat, and the review moves on", async () => {
  const run = await answer(" 42 ");
  assert.equal(run.rendered, `${RECORD} > tg.deleteMessage > ${NEXT}`);
  assert.equal(
    run.calls.find((call) => call.method === "deleteMessage")?.payload
      .message_id,
    100,
  );
});

test("a reply that cannot be deleted does not stop the review", async () => {
  const harness = await botHarness();
  harness.obsidian.readDailyNote = { path: "p.md", content: NOTE };
  harness.obsidian.readNote = NOTE;
  harness.failApi.add("deleteMessage");
  const run = await harness.say("42", { message_id: 7, text: QUESTION });
  assert.equal(run.rendered, `${RECORD} > tg.deleteMessage > ${NEXT}`);
});

test("an answer that is not a number is refused in the chat and nothing is written", async () => {
  const run = await answer("a lot");
  assert.deepEqual(run.texts("sendMessage"), [
    "That's not a number. Reply with a number only.",
  ]);
  assert.equal(run.rendered, "tg.sendMessage");
});

test("an answer for a habit that is gone gets a plain reply and no write", async () => {
  const run = await answer("5", null);
  assert.deepEqual(run.texts("sendMessage"), [
    "Couldn't find that habit to update.",
  ]);
  assert.equal(run.rendered, "obsidian.readDailyNote > tg.sendMessage");
});
