import assert from "node:assert/strict";
import { test } from "node:test";
import { Api, BotError, Context, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import { BOT_INFO, recordingApi } from "../test/fakes.ts";
import { errorHandler } from "./errors.ts";

const chat = { id: 1, type: "private" as const, first_name: "me" };
const from = { id: 1, is_bot: false, first_name: "me" };
const TAP = {
  callback_query: {
    id: "q1",
    from,
    chat_instance: "ci",
    data: "rt:aaaaaaaa",
    message: { message_id: 50, date: 0, chat, text: "card" },
  },
};
const MESSAGE = {
  message: { message_id: 5, date: 0, chat, from, text: "buy milk" },
};

function harness(jotId?: string, lookupFails = false) {
  const api = new Api("t");
  const rec = recordingApi();
  api.config.use(rec.transformer as never);
  const handler = errorHandler({
    jotForMessage: async () => {
      if (lookupFails) throw new Error("db is locked");
      return jotId;
    },
    failureButtons: (id) =>
      new InlineKeyboard()
        .text("🔄 Retry", `rt:${id}`)
        .text("🗑 Delete", `dl:${id}`),
  });
  const fail = (error: unknown, update: object) =>
    handler(
      new BotError(
        error,
        new Context({ update_id: 1, ...update } as Update, api, BOT_INFO),
      ),
    );
  return { rec, fail };
}

test("a failed tap gets a toast of at most 200 characters and no message", async () => {
  const { rec, fail } = harness("aaaaaaaa");
  await fail(new Error("db is locked"), TAP);
  await fail(new Error("x".repeat(500)), TAP);
  assert.equal(rec.answers()[0], "⚠️ db is locked");
  assert.equal(rec.answers()[1]?.length, 200);
  assert.ok(rec.answers()[1]?.startsWith("⚠️ xxx"));
  assert.deepEqual(rec.texts("sendMessage"), []);

  rec.fail.add("answerCallbackQuery");
  await fail(new Error("again"), TAP);
});

test("a failed message gets Retry and Delete when it already has a jot, a plain error otherwise", async () => {
  const withJot = harness("aaaaaaaa");
  await withJot.fail(new Error("obsidian is down"), MESSAGE);
  const reply = withJot.rec.calls[0];
  assert.equal(reply?.payload.text, "⚠️ Couldn't save that: obsidian is down");
  assert.deepEqual(withJot.rec.buttons(reply), [
    ["🔄 Retry", "rt:aaaaaaaa"],
    ["🗑 Delete", "dl:aaaaaaaa"],
  ]);

  const noJot = harness();
  await noJot.fail("disk full", MESSAGE);
  assert.deepEqual(noJot.rec.texts("sendMessage"), [
    "⚠️ Couldn't save that: disk full",
  ]);
  assert.deepEqual(noJot.rec.buttons(noJot.rec.calls[0]), []);

  const lookupFails = harness("aaaaaaaa", true);
  lookupFails.rec.fail.add("sendMessage");
  await lookupFails.fail(new Error("boom"), MESSAGE);
  assert.deepEqual(lookupFails.rec.buttons(lookupFails.rec.calls[0]), []);
});
