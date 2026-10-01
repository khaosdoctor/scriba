import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness, type Harness } from "../../test/bot-harness.ts";

/** A write/delete question the agent is parked on, with what the owner decided recorded. */
function ask(h: Harness, id: string, decided: boolean[]) {
  h.bot.command.pending.set(id, {
    decide: (allow: boolean) => void decided.push(allow),
    timer: setTimeout(() => {}, 0),
  });
}

test("a confirmation tap marks the question answered, drops its buttons and settles the agent's wait", async () => {
  const h = await botHarness();
  const decided: boolean[] = [];
  ask(h, "c1", decided);
  const yes = await h.tap("cm:y:c1", { message: { text: "✏️ Write a.md?" } });
  const edit = yes.calls.find((c) => c.method === "editMessageText")!;
  assert.equal(edit.payload.text, "✏️ Write a.md?\n✅ approved");
  // grammy's empty InlineKeyboard is one empty row; Telegram reads it as no buttons.
  assert.deepEqual(edit.payload.reply_markup.inline_keyboard, [[]]);
  assert.deepEqual(decided, [true]);

  ask(h, "c2", decided);
  const no = await h.tap("cm:n:c2", { message: { text: "🗑 Delete a.md?" } });
  assert.deepEqual(no.texts("editMessageText"), [
    "🗑 Delete a.md?\n❌ declined",
  ]);
  assert.deepEqual(decided, [true, false]);
});
