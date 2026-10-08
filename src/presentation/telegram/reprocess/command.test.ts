import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness, sampleJot } from "../../../test/bot-harness.ts";
import { ROOT_TEXT } from "./tap.ts";

test("/reprocess opens the scope picker with a Close button", async () => {
  const harness = await botHarness();
  const run = await harness.say("/reprocess");
  assert.deepEqual(run.texts("sendMessage"), [ROOT_TEXT]);
  assert.deepEqual(
    run.calls[0]?.payload.reply_markup.inline_keyboard
      .flat()
      .map((button: { text: string; callback_data: string }) => [
        button.text,
        button.callback_data,
      ]),
    [
      ["📅 One day", "rp:day"],
      ["📆 Date range", "rp:range"],
      ["✉️ One jot", "rp:jot:0"],
      ["✖ Close", "rp:close"],
    ],
  );
});

test("/reprocess <id> queues that jot without opening the picker", async () => {
  const harness = await botHarness();
  const queued: string[][] = [];
  harness.repo.getJot = async (id: string) =>
    id === "aaaa1111" ? sampleJot({ id, anchor: id }) : undefined;
  harness.repo.resetForReprocess = async (ids: string[]) => ids;
  harness.queue.add = (ids: string[]) => void queued.push(ids);
  const run = await harness.say("/reprocess AAAA1111");
  assert.deepEqual(run.texts("sendMessage"), [
    "🔁 Reprocessing 1 jot from aaaa1111…",
  ]);
  assert.equal(run.calls[0]?.payload.reply_markup, undefined);
  assert.deepEqual(queued, [["aaaa1111"]]);
});

test("/reprocess with an unknown id says so", async () => {
  const harness = await botHarness();
  harness.repo.getJot = async () => undefined;
  const run = await harness.say("/reprocess deadbeef");
  assert.deepEqual(run.texts("sendMessage"), ["Jot deadbeef not found."]);
});
