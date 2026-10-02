import assert from "node:assert/strict";
import { test } from "node:test";
import { Api, Context, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import { BOT_INFO, recordingApi } from "../../test/fakes.ts";
import { Chat, Responder } from "./chat.ts";

const OWNER = 1;
const chat = { id: OWNER, type: "private" as const, first_name: "me" };
const from = { id: OWNER, is_bot: false, first_name: "me" };

function harness() {
  const api = new Api("t");
  const rec = recordingApi();
  api.config.use(rec.transformer as never);
  const ctx = (update: object) =>
    new Context({ update_id: 1, ...update } as Update, api, BOT_INFO);
  return { api, rec, chat: new Chat(api, OWNER), ctx };
}

/** A tap on the bot's message 50, and the owner's own message 5. */
const TAP = {
  callback_query: {
    id: "q1",
    from,
    chat_instance: "ci",
    data: "x",
    message: { message_id: 50, date: 0, chat, text: "card" },
  },
};
const MESSAGE = { message: { message_id: 5, date: 0, chat, from, text: "hi" } };

/** A call's payload as Telegram receives it (a keyboard instance becomes plain JSON). */
const wire = (c: { payload: unknown }) => JSON.parse(JSON.stringify(c.payload));

test("the chat sends plain notices and HTML messages with a keyboard to the owner", async () => {
  const { chat, rec } = harness();
  await chat.notify("hello");
  const id = await chat.send("<b>hi</b>", {
    html: true,
    keyboard: new InlineKeyboard().text("Yes", "lk:y:p1"),
  });
  assert.equal(id, 901);
  assert.deepEqual(rec.calls.map(wire), [
    { chat_id: OWNER, text: "hello" },
    {
      chat_id: OWNER,
      text: "<b>hi</b>",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "Yes", callback_data: "lk:y:p1" }]],
      },
    },
  ]);
});

test("a message can ask for a forced reply or hang off an earlier message, and one without the options does neither", async () => {
  const { chat, rec } = harness();
  await chat.send("when?", { forceReply: true });
  // Telegram refuses a reply to a message that's gone unless this is set.
  await chat.send("done", { replyTo: 5 });
  await chat.send("when?");
  assert.deepEqual(rec.calls.map(wire), [
    { chat_id: OWNER, text: "when?", reply_markup: { force_reply: true } },
    {
      chat_id: OWNER,
      text: "done",
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
    },
    { chat_id: OWNER, text: "when?" },
  ]);
});

test("a message that must interrupt says so to Telegram explicitly", async () => {
  const { chat, rec } = harness();
  await chat.send("<b>tasks</b>", { html: true, silent: false });
  assert.deepEqual(rec.calls.map(wire), [
    {
      chat_id: OWNER,
      text: "<b>tasks</b>",
      parse_mode: "HTML",
      disable_notification: false,
    },
  ]);
});

test("the chat edits, deletes and reacts to a message by id, and rejects only on edit and delete", async () => {
  const { chat, rec } = harness();
  await chat.edit(7, "later", { keyboard: new InlineKeyboard() });
  await chat.delete(7);
  await chat.react(7, "👌");
  await chat.typing();
  assert.deepEqual(
    rec.calls.map((c) => [c.method, wire(c)]),
    [
      [
        "editMessageText",
        {
          chat_id: OWNER,
          message_id: 7,
          text: "later",
          reply_markup: { inline_keyboard: [[]] },
        },
      ],
      ["deleteMessage", { chat_id: OWNER, message_id: 7 }],
      [
        "setMessageReaction",
        {
          chat_id: OWNER,
          message_id: 7,
          reaction: [{ type: "emoji", emoji: "👌" }],
        },
      ],
      ["sendChatAction", { chat_id: OWNER, action: "typing" }],
    ],
  );

  rec.fail.add("editMessageText").add("deleteMessage");
  rec.fail.add("setMessageReaction").add("sendChatAction");
  await assert.rejects(chat.edit(7, "x"));
  await assert.rejects(chat.delete(7));
  await chat.react(7, "👌");
  await chat.typing();
});

test("a tap's responder answers the query with a toast, an alert or nothing", async () => {
  const { ctx, rec } = harness();
  const r = new Responder(ctx(TAP));
  await r.ack();
  await r.ack("done");
  await r.ack("try again", { alert: true });
  assert.deepEqual(rec.calls.map(wire), [
    { callback_query_id: "q1" },
    { callback_query_id: "q1", text: "done" },
    { callback_query_id: "q1", text: "try again", show_alert: true },
  ]);
});

test("dropping buttons makes no edit when no button matches the prefix or there is no keyboard", async () => {
  const { ctx, rec } = harness();
  const keyboard = {
    callback_query: {
      ...TAP.callback_query,
      message: {
        ...TAP.callback_query.message,
        reply_markup: {
          inline_keyboard: [[{ text: "Embed", callback_data: "em:a:1" }]],
        },
      },
    },
  };
  await new Responder(ctx(keyboard)).dropButtons("un:");
  await new Responder(ctx(TAP)).dropButtons("un:");
  assert.deepEqual(rec.calls, []);
});

test("an update's responder replies in its chat or removes its message", async () => {
  const { ctx, rec } = harness();
  const r = new Responder(ctx(MESSAGE));
  assert.equal(await r.reply("<i>sure</i>", { html: true }), 900);
  await r.remove();
  assert.deepEqual(
    rec.calls.map((c) => [c.method, wire(c)]),
    [
      [
        "sendMessage",
        { chat_id: OWNER, text: "<i>sure</i>", parse_mode: "HTML" },
      ],
      ["deleteMessage", { chat_id: OWNER, message_id: 5 }],
    ],
  );
});

test("closeMessage deletes the message and leaves it at that", async () => {
  const { ctx, rec } = harness();
  await new Responder(ctx(TAP)).closeMessage("Closed.");
  assert.deepEqual(
    rec.calls.map((c) => [c.method, wire(c)]),
    [["deleteMessage", { chat_id: OWNER, message_id: 50 }]],
  );
});

test("closeMessage clears the buttons with the fallback text when the delete is refused", async () => {
  const { ctx, rec } = harness();
  rec.fail.add("deleteMessage");
  await new Responder(ctx(TAP)).closeMessage("Closed.");
  assert.deepEqual(
    rec.calls.map((c) => [c.method, wire(c)]),
    [
      ["deleteMessage", { chat_id: OWNER, message_id: 50 }],
      [
        "editMessageText",
        {
          chat_id: OWNER,
          message_id: 50,
          text: "Closed.",
          reply_markup: { inline_keyboard: [[]] },
        },
      ],
    ],
  );
});

test("closeMessage rejects when the message can be neither deleted nor edited", async () => {
  const { ctx, rec } = harness();
  rec.fail.add("deleteMessage").add("editMessageText");
  await assert.rejects(new Responder(ctx(TAP)).closeMessage("Closed."));
  assert.deepEqual(
    rec.calls.map((c) => c.method),
    ["deleteMessage", "editMessageText"],
  );
});

test("closeMessage runs onClosed before touching the message", async () => {
  const { ctx, rec } = harness();
  const order: string[] = [];
  await new Responder(ctx(TAP)).closeMessage("Closed.", () => {
    order.push(`onClosed after ${rec.calls.length} calls`);
  });
  assert.deepEqual(order, ["onClosed after 0 calls"]);
  assert.equal(rec.calls.length, 1);
});
