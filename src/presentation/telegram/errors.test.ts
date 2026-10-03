import assert from "node:assert/strict";
import { test } from "node:test";
import { Api, BotError, Context } from "grammy";
import type { Update } from "grammy/types";
import { BOT_INFO, recordingApi } from "../../test/fakes.ts";
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
    idForMessage: async () => {
      if (lookupFails) throw new Error("db is locked");
      return jotId;
    },
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

test("a tap whose error toast Telegram refuses is still swallowed", async () => {
  const { rec, fail } = harness("aaaaaaaa");
  rec.fail.add("answerCallbackQuery");
  await fail(new Error("again"), TAP);
});

test("an update with neither a tap nor a message is swallowed", async () => {
  const { rec, fail } = harness("aaaaaaaa");
  await fail(new Error("odd update"), { poll: { id: "p" } });
  assert.deepEqual(rec.texts("sendMessage"), []);
});

test("a failed message with no jot, or whose lookup and reply both fail, gets a plain error", async () => {
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
