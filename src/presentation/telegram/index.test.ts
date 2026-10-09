import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness } from "../../test/bot-harness.ts";
import { COMMANDS } from "./commands.ts";

test("every command Telegram lists gets an answer from the bot", async () => {
  for (const { command } of COMMANDS) {
    const harness = await botHarness();
    const run = await harness.say(`/${command}`);
    assert.ok(run.calls.length > 0, `/${command} went unanswered`);
    for (const text of run.texts("sendMessage"))
      assert.doesNotMatch(text, /^⚠️ Couldn't save that/, `/${command}`);
  }
});

test("/help lists every command with its example, everyday ones before admin ones", async () => {
  const harness = await botHarness();
  const run = await harness.say("/help");
  assert.equal(run.rendered, "tg.sendMessage");
  assert.equal(run.calls[0]?.payload.parse_mode, "HTML");
  const [text = ""] = run.texts("sendMessage");
  for (const { command, example } of COMMANDS) {
    assert.match(text, new RegExp(`<b>/${command}</b>: `), command);
    if (example) assert.ok(text.includes("<i>e.g.</i> "), command);
  }
  assert.ok(text.indexOf("/taskadd") < text.indexOf("🛠 Admin"));
  assert.ok(text.indexOf("🛠 Admin") < text.indexOf("/stopword"));
  assert.ok(text.includes("/jot &lt;id&gt;"));
});

test("an update from anyone but the owner is dropped, whatever its kind", async () => {
  const harness = await botHarness();
  const stranger = { id: 2, is_bot: false, first_name: "Someone" };
  const chat = { id: 2, type: "private" as const };
  const message = {
    message_id: 5,
    date: 0,
    chat,
    from: stranger,
    text: "/start",
    entities: [{ type: "bot_command", offset: 0, length: 6 }],
  };
  const updates = [
    { message },
    { edited_message: { ...message, text: "edited", edit_date: 1 } },
    {
      callback_query: {
        id: "cb",
        from: stranger,
        chat_instance: "ci",
        data: "menu:close",
        message: { message_id: 50, date: 0, chat, text: "card" },
      },
    },
    {
      message_reaction: {
        chat,
        message_id: 5,
        user: stranger,
        date: 0,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🤝" }],
      },
    },
  ];
  for (const update of updates) {
    const run = await harness.run(update);
    assert.equal(run.rendered, "", Object.keys(update)[0]);
  }
});
