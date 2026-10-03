import assert from "node:assert/strict";
import { test } from "node:test";
import { MenuLifetime } from "./menu-lifetime.ts";

function harness(refuse = false) {
  const deleted: [number, number][] = [];
  const api = {
    deleteMessage: async (chatId: number, msgId: number) => {
      deleted.push([chatId, msgId]);
      if (refuse) throw new Error("message to delete not found");
      return true as const;
    },
  };
  return { deleted, menus: new MenuLifetime(api) };
}

test("a menu message self-destructs after a minute of no taps", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { menus, deleted } = harness();
  menus.opened(7, 42);
  context.mock.timers.tick(59_000);
  assert.deepEqual(deleted, []);
  context.mock.timers.tick(2_000);
  assert.deepEqual(deleted, [[7, 42]]);
});

test("each tap restarts the countdown, and closing cancels it", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { menus, deleted } = harness();
  menus.opened(7, 42);
  context.mock.timers.tick(50_000);
  menus.touch(7, 42); // a tap
  context.mock.timers.tick(50_000); // 100s since the send, 50s since the tap
  assert.deepEqual(deleted, []);
  menus.closed(7, 42);
  context.mock.timers.tick(120_000);
  assert.deepEqual(deleted, []);
});

test("closing a menu by hand, even one that is no longer the chat's last, leaves nothing to retire", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { menus, deleted } = harness(true);
  menus.opened(7, 42);
  await menus.retire(7);
  menus.opened(7, 43);
  menus.closed(7, 42);
  await menus.retire(7);
  assert.deepEqual(deleted, [[7, 42]], "43 is not retired");
  context.mock.timers.tick(61_000);
  assert.deepEqual(
    deleted,
    [
      [7, 42],
      [7, 43],
    ],
    "43's own countdown still runs",
  );
});

test("opening a fresh root menu retires the previous one in that chat, once", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { menus, deleted } = harness(true);
  await menus.retire(7);
  assert.deepEqual(deleted, []);

  menus.opened(7, 42);
  await menus.retire(7);
  assert.deepEqual(deleted, [[7, 42]]);
  context.mock.timers.tick(120_000);
  assert.deepEqual(deleted, [[7, 42]], "the retired menu's countdown is gone");

  menus.opened(7, 43);
  context.mock.timers.tick(61_000);
  await menus.retire(7);
  assert.deepEqual(deleted, [
    [7, 42],
    [7, 43],
  ]);
});
