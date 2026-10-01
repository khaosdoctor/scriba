import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness } from "../../test/bot-harness.ts";

const NOTE = [
  "## Things to do",
  "- [ ] Buy cat sand #type/todo [due:: 2099-01-01]",
  "- [ ] Pay the invoice #type/todo [due:: 2020-01-01]",
].join("\n");

const list = async (command: string, note: string | (() => never) = NOTE) => {
  const h = await botHarness();
  h.obsidian.readNote = note;
  return h.say(command);
};

test("/tasks with no argument lists the open tasks ahead", async () => {
  const run = await list("/tasks");
  const [text] = run.texts("sendMessage");
  assert.match(text ?? "", /🔭 Open tasks ahead/);
  assert.match(text ?? "", /Buy cat sand/);
  assert.doesNotMatch(text ?? "", /Pay the invoice/);
  assert.equal(run.calls[0]?.payload.parse_mode, "HTML");
});

test("/tasks takes a screen by name or by alias", async () => {
  assert.match(
    (await list("/tasks late")).texts("sendMessage")[0] ?? "",
    /⏰ Overdue[\s\S]*Pay the invoice/,
  );
  assert.match(
    (await list("/tasks all")).texts("sendMessage")[0] ?? "",
    /📋 All open tasks/,
  );
});

test("/tasks with an unknown screen lists the ones it knows and reads nothing", async () => {
  const run = await list("/tasks nonsense");
  assert.deepEqual(run.texts("sendMessage"), [
    "Usage: /tasks [day | all | open | overdue | late | today | week | two | fortnight | done]",
  ]);
  assert.equal(run.rendered, "tg.sendMessage");
});

test("/tasks says so when the task notes cannot be read", async () => {
  const run = await list("/tasks", () => {
    throw new Error("obsidian is down");
  });
  assert.deepEqual(run.texts("sendMessage"), [
    "⚠️ Couldn't read your task notes: obsidian is down",
  ]);
});
