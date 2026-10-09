import assert from "node:assert/strict";
import { test } from "node:test";
import { TELEGRAM_LIMIT } from "../../libs/text.ts";
import { botHarness, sampleJot } from "../../test/bot-harness.ts";
import { COMMANDS } from "./commands.ts";

type Row = { text: string; callback_data: string }[];

const rowsOf = (call: { payload: any } | undefined): Row[] =>
  (call?.payload.reply_markup?.inline_keyboard ?? []).filter(
    (row: Row) => row.length,
  );

test("every command is safe to hand to setMyCommands, once", () => {
  const names = COMMANDS.map((entry) => entry.command);
  assert.deepEqual(
    names.filter((name, index) => names.indexOf(name) !== index),
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
  const harness = await botHarness();
  const run = await harness.say("/failed");
  assert.deepEqual(run.texts("sendMessage"), ["✅ nothing failed."]);
  assert.deepEqual(rowsOf(run.calls[0]), []);
});

test("/failed gives each jot the retry and delete pair the failure messages carry", async () => {
  const harness = await botHarness();
  harness.repo.failedJots = async () => [
    sampleJot({ id: "abcd1234", status: "failed", attempts: 2, error: "boom" }),
    sampleJot({ id: "ffff0001", status: "abandoned" }),
  ];
  const run = await harness.say("/failed");
  const [text] = run.texts("sendMessage");
  assert.match(text!, /2 failed/);
  assert.deepEqual(
    rowsOf(run.calls[0]).map((row) =>
      row.map((button) => button.callback_data),
    ),
    [
      ["rt:abcd1234", "dl:abcd1234"],
      ["rt:ffff0001", "dl:ffff0001"],
    ],
  );
});

test("/unreject with no args offers one button per rejected word", async () => {
  const harness = await botHarness();
  const none = await harness.say("/unreject");
  assert.deepEqual(none.texts("sendMessage"), ["(no rejections)"]);

  harness.repo.rejectionList = async () => [
    { surface: "monday", note: "Monday" },
    { surface: "monday", note: "Mondays" },
    { surface: "norway", note: "Norway" },
  ];
  const run = await harness.say("/unreject");
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
  const harness = await botHarness();
  harness.repo.rejectionList = async () =>
    Array.from({ length: 35 }, (_, index) => ({
      surface: `word${index}`,
      note: "N",
    }));
  const run = await harness.say("/unreject");
  assert.equal(
    run.texts("sendMessage")[0],
    `Pick a rejected word to unreject (30 of 35 ${String.fromCharCode(0x2014)} /menu › 🔗 Link rules pages through the rest):`,
  );
  assert.equal(rowsOf(run.calls[0]).length, 30);
});

test("an admin answer longer than Telegram's limit is cut instead of rejected", async () => {
  const harness = await botHarness();
  harness.repo.getJot = async () =>
    sampleJot({ id: "abcd1234", raw_text: "x".repeat(TELEGRAM_LIMIT * 2) });
  const run = await harness.say("/jot abcd1234");
  const [text] = run.texts("sendMessage");
  assert.ok(text!.length <= TELEGRAM_LIMIT);
  assert.match(text!, /abcd1234/);
});

test("/fix takes the jot from its argument or from the message it replies to", async () => {
  const harness = await botHarness();
  harness.repo.jotForMessage = "bbbb2222";
  const typed = await harness.say("/fix AAAA1111");
  assert.deepEqual(typed.texts("sendMessage").slice(0, 1), [
    "🔧 Fixing aaaa1111…",
  ]);
  const replied = await harness.say("/fix", { message_id: 77 });
  assert.deepEqual(replied.texts("sendMessage").slice(0, 1), [
    "🔧 Fixing bbbb2222…",
  ]);
});

test("/fix with no jot to act on says how to use it", async () => {
  const harness = await botHarness();
  harness.repo.jotForMessage = undefined;
  const bare = await harness.say("/fix");
  const unmapped = await harness.say("/fix", { message_id: 77 });
  for (const run of [bare, unmapped])
    assert.deepEqual(run.texts("sendMessage"), [
      "Send /fix <id>, or reply /fix to a journal message.",
    ]);
});
