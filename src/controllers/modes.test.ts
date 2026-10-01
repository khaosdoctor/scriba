import assert from "node:assert/strict";
import { test } from "node:test";
import { Modes } from "./modes.ts";

const IDLE = 1000;

function setup(commandOpen = false) {
  const notices: string[] = [];
  const state = { commandOpen };
  const modes = new Modes(
    { notify: async (text) => void notices.push(text) },
    () => state.commandOpen,
    IDLE,
  );
  return { modes, notices, state };
}

test("task mode opens once, says so when it is already on, and closes", () => {
  const { modes } = setup();
  assert.equal(modes.open("task"), "opened");
  assert.equal(modes.isOpen("task"), true);
  assert.equal(modes.open("task"), "already");
  modes.close();
  assert.equal(modes.isOpen("task"), false);
  assert.equal(modes.open("task"), "opened");
  modes.close();
});

test("task mode refuses to open while command mode holds the message stream", () => {
  const { modes, state } = setup(true);
  assert.equal(modes.open("task"), "busy");
  assert.equal(modes.isOpen("task"), false);
  state.commandOpen = false;
  assert.equal(modes.open("task"), "opened");
  modes.close();
});

test("an idle mode closes itself and tells the owner, and a message restarts the countdown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { modes, notices } = setup();
  modes.open("task");
  t.mock.timers.tick(IDLE - 1);
  modes.touch();
  t.mock.timers.tick(IDLE - 1);
  assert.equal(modes.isOpen("task"), true);
  assert.deepEqual(notices, []);
  t.mock.timers.tick(1);
  assert.equal(modes.isOpen("task"), false);
  assert.deepEqual(notices, ["📝 Task mode timed out — back to journaling."]);
});

test("closing a mode cancels its timeout notice, and touching a closed one arms nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { modes, notices } = setup();
  modes.open("task");
  modes.close();
  modes.touch();
  t.mock.timers.tick(IDLE * 2);
  assert.deepEqual(notices, []);
});

test("a timeout notice that cannot be sent does not stop the mode from closing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const modes = new Modes(
    {
      notify: async () => {
        throw new Error("telegram is down");
      },
    },
    () => false,
    IDLE,
  );
  modes.open("task");
  t.mock.timers.tick(IDLE);
  await Promise.resolve();
  assert.equal(modes.isOpen("task"), false);
});
