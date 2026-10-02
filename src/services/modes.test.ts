import assert from "node:assert/strict";
import { test } from "node:test";
import { Modes } from "./modes.ts";

const IDLE = 1000;

function setup() {
  const notices: string[] = [];
  const modes = new Modes(
    { notify: async (text) => void notices.push(text) },
    IDLE,
  );
  return { modes, notices };
}

test("a mode opens once, says so when it is already on, and closes", () => {
  const { modes } = setup();
  assert.equal(modes.current(), undefined);
  assert.equal(modes.open("task"), "opened");
  assert.equal(modes.isOpen("task"), true);
  assert.equal(modes.current(), "task");
  assert.equal(modes.open("task"), "already");
  modes.close();
  assert.equal(modes.isOpen("task"), false);
  assert.equal(modes.open("task"), "opened");
  modes.close();
});

test("the two modes refuse to open over each other", () => {
  const { modes } = setup();
  assert.equal(modes.open("command"), "opened");
  assert.equal(modes.open("task"), "busy");
  assert.equal(modes.isOpen("task"), false);
  modes.close();
  assert.equal(modes.open("task"), "opened");
  assert.equal(modes.open("command"), "busy");
  assert.equal(modes.current(), "task");
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

test("command mode idles out with its own notice, after its close hook has run", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { modes, notices } = setup();
  const hook: string[] = [];
  modes.open("command", () => hook.push(`closed, ${notices.length} notices`));
  t.mock.timers.tick(IDLE);
  assert.equal(modes.isOpen("command"), false);
  assert.deepEqual(hook, ["closed, 0 notices"]);
  assert.deepEqual(notices, [
    "🧭 Command mode timed out — back to journaling.",
  ]);
});

test("closing a mode runs its hook once and cancels its timeout notice, and touching a closed one arms nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { modes, notices } = setup();
  const closes: number[] = [];
  modes.open("task", () => closes.push(1));
  modes.close();
  modes.close();
  modes.touch();
  t.mock.timers.tick(IDLE * 2);
  assert.deepEqual(closes, [1]);
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
    IDLE,
  );
  modes.open("task");
  t.mock.timers.tick(IDLE);
  await Promise.resolve();
  assert.equal(modes.isOpen("task"), false);
});
