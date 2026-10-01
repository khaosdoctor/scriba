import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness, EM } from "../test/bot-harness.ts";
import { COMMANDS } from "./commands/index.ts";

const HELP = [
  "🛠 commands:",
  `/version ${EM} bot version + commit sha`,
  `/changelog ${EM} what's new ${EM} /changelog [version|N]`,
  `/stats ${EM} jot counts ${EM} /stats [today|week|all]`,
  `/status ${EM} health snapshot`,
  `/failed ${EM} recent failed/abandoned jots, each with retry + delete buttons`,
  `/jot ${EM} dump one jot's record ${EM} /jot <id>`,
  `/flush ${EM} drain the flush queue now`,
  `/retry ${EM} requeue failed jots ${EM} /retry [id|all]`,
  `/sweep ${EM} run the retry sweep now`,
  `/unstick ${EM} reset jots wedged in 'processing'`,
  `/stopword ${EM} manage stopwords ${EM} /stopword add|del|list [word|page]`,
  `/rejections ${EM} list learned link-rejections ${EM} /rejections [page]`,
  `/unreject ${EM} undo a link-rejection (menu, or /unreject <word> <note>)`,
  `/help ${EM} list admin commands`,
].join("\n");

test("every command Telegram lists gets an answer from the bot", async () => {
  for (const { command } of COMMANDS) {
    const h = await botHarness();
    h.bot.github = {
      latest: async () => null,
      recent: async () => [],
      byVersion: async () => null,
    };
    const run = await h.say(`/${command}`);
    assert.ok(run.calls.length > 0, `/${command} went unanswered`);
    for (const text of run.texts("sendMessage"))
      assert.doesNotMatch(text, /^⚠️ Couldn't save that/, `/${command}`);
  }
});

test("/help lists the admin commands only, itself last", async () => {
  const h = await botHarness();
  const run = await h.say("/help");
  assert.equal(run.rendered, "tg.sendMessage");
  assert.equal(run.texts("sendMessage")[0], HELP);
});

test("an update from anyone but the owner is dropped, whatever its kind", async () => {
  const h = await botHarness();
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
    const run = await h.run(update);
    assert.equal(run.rendered, "", Object.keys(update)[0]);
  }
});
