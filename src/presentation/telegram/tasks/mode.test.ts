import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness } from "../../../test/bot-harness.ts";

test("/task opens task mode, and the next message becomes a card with nothing written to the note", async () => {
  const harness = await botHarness();
  const open = await harness.say("/task");
  assert.match(open.texts("sendMessage")[0] ?? "", /^📝 Task mode is on\./);

  const run = await harness.say("buy cat sand next week");
  assert.equal(
    run.rendered,
    "repo.insertTaskDraft > tg.sendMessage > repo.updateTaskDraft",
  );
  const card = run.calls[0]!;
  assert.match(card.payload.text, /📝 New task/);
  assert.equal(card.payload.parse_mode, "HTML");
  assert.deepEqual(
    card.payload.reply_markup.inline_keyboard
      .flat()
      .map(
        (button: { callback_data: string }) =>
          button.callback_data.split(":")[1],
      ),
    ["d", "t", "s", "u", "ok", "x"],
  );
});

test("a message with no task in it gets a nudge instead of a card", async () => {
  const harness = await botHarness();
  await harness.say("/task");
  const run = await harness.say("next week");
  assert.deepEqual(run.texts("sendMessage"), [
    "I couldn't find anything to do in that — send the task itself, like “buy cat sand next week”.",
  ]);
  assert.equal(run.rendered, "tg.sendMessage");
});

test("/done closes task mode, and the next message is a journal entry again", async () => {
  const harness = await botHarness();
  await harness.say("/task");
  await harness.say("/done");
  const run = await harness.say("bought milk");
  assert.doesNotMatch(run.rendered, /insertTaskDraft/);
  assert.match(run.rendered, /repo\.insertJot/);
});
