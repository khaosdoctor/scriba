import assert from "node:assert/strict";
import { test } from "node:test";
import { TELEGRAM_LIMIT } from "../../lib/text.ts";
import { botHarness, sampleJot } from "../../test/bot-harness.ts";
import { COMMANDS } from "./index.ts";

type Row = { text: string; callback_data: string }[];

const rowsOf = (call: { payload: any } | undefined): Row[] =>
  (call?.payload.reply_markup?.inline_keyboard ?? []).filter(
    (row: Row) => row.length,
  );

test("every command is safe to hand to setMyCommands, once", () => {
  const names = COMMANDS.map((c) => c.command);
  assert.deepEqual(
    names.filter((n, i) => names.indexOf(n) !== i),
    [],
    "duplicate command names would register two handlers for one command",
  );
  for (const { command, description } of COMMANDS) {
    // setMyCommands rejects anything outside this shape, and the bot only warns on that
    // failure, so one bad name silently costs the whole `/` menu.
    assert.match(command, /^[a-z0-9_]{1,32}$/, `bad command name: ${command}`);
    assert.ok(description.trim(), `/${command} has no description`);
    assert.ok(
      description.length <= 256,
      `/${command}'s description is too long`,
    );
  }
});

test("/failed answers nothing failed without buttons", async () => {
  const h = await botHarness();
  const run = await h.say("/failed");
  assert.deepEqual(run.texts("sendMessage"), ["✅ nothing failed."]);
  assert.deepEqual(rowsOf(run.calls[0]), []);
});

test("/failed gives each jot the retry and delete pair the failure messages carry", async () => {
  const h = await botHarness();
  h.repo.failedJots = async () => [
    sampleJot({ id: "abcd1234", status: "failed", attempts: 2, error: "boom" }),
    sampleJot({ id: "ffff0001", status: "abandoned" }),
  ];
  const run = await h.say("/failed");
  const [text] = run.texts("sendMessage");
  assert.match(text!, /2 failed/);
  assert.deepEqual(
    rowsOf(run.calls[0]).map((row) => row.map((b) => b.callback_data)),
    [
      ["rt:abcd1234", "dl:abcd1234"],
      ["rt:ffff0001", "dl:ffff0001"],
    ],
  );
});

test("/unreject with no args offers one button per rejected word", async () => {
  const h = await botHarness();
  const none = await h.say("/unreject");
  assert.deepEqual(none.texts("sendMessage"), ["(no rejections)"]);

  h.repo.rejectionList = async () => [
    { surface: "monday", note: "Monday" },
    { surface: "monday", note: "Mondays" },
    { surface: "norway", note: "Norway" },
  ];
  const run = await h.say("/unreject");
  assert.deepEqual(run.texts("sendMessage"), [
    "Pick a rejected word to unreject:",
  ]);
  assert.deepEqual(
    rowsOf(run.calls[0]).map((row) => [row[0]!.text, row[0]!.callback_data]),
    [
      ["monday", "ur:s:0"],
      ["norway", "ur:s:1"],
    ],
  );
});

test("/unreject names the cut when more than 30 words are rejected", async () => {
  const h = await botHarness();
  h.repo.rejectionList = async () =>
    Array.from({ length: 35 }, (_, i) => ({ surface: `word${i}`, note: "N" }));
  const run = await h.say("/unreject");
  assert.equal(
    run.texts("sendMessage")[0],
    `Pick a rejected word to unreject (30 of 35 ${String.fromCharCode(0x2014)} /menu › 🔗 Link rules pages through the rest):`,
  );
  assert.equal(rowsOf(run.calls[0]).length, 30);
});

test("an admin answer longer than Telegram's limit is cut instead of rejected", async () => {
  const h = await botHarness();
  h.repo.getJot = async () =>
    sampleJot({ id: "abcd1234", raw_text: "x".repeat(TELEGRAM_LIMIT * 2) });
  const run = await h.say("/jot abcd1234");
  const [text] = run.texts("sendMessage");
  assert.ok(text!.length <= TELEGRAM_LIMIT);
  assert.match(text!, /abcd1234/);
});
