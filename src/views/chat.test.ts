import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "grammy";
import { closeMessage } from "./chat.ts";

function fakeCtx(opts: { deleteFails?: boolean; editFails?: boolean }) {
  const calls: string[] = [];
  const ctx = {
    deleteMessage: async () => {
      calls.push("delete");
      if (opts.deleteFails) throw new Error("too old");
    },
    editMessageText: async (text: string, other: unknown) => {
      calls.push(`edit:${text}:${JSON.stringify(other)}`);
      if (opts.editFails) throw new Error("gone");
    },
  };
  return { ctx: ctx as unknown as Context, calls };
}

test("closeMessage deletes the message and leaves it at that", async () => {
  const { ctx, calls } = fakeCtx({});
  await closeMessage(ctx, "Closed.");
  assert.deepEqual(calls, ["delete"]);
});

test("closeMessage clears the buttons with the fallback text when the delete is refused", async () => {
  const { ctx, calls } = fakeCtx({ deleteFails: true });
  await closeMessage(ctx, "Closed.");
  assert.deepEqual(calls, [
    "delete",
    'edit:Closed.:{"reply_markup":{"inline_keyboard":[[]]}}',
  ]);
});

test("closeMessage rejects when the message can be neither deleted nor edited", async () => {
  const { ctx } = fakeCtx({ deleteFails: true, editFails: true });
  await assert.rejects(closeMessage(ctx, "Closed."), /gone/);
});

test("closeMessage runs onClosed before touching the message", async () => {
  const { ctx, calls } = fakeCtx({});
  await closeMessage(ctx, "Closed.", () => calls.push("onClosed"));
  assert.deepEqual(calls, ["onClosed", "delete"]);
});
