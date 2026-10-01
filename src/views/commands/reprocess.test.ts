import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness } from "../../test/bot-harness.ts";
import { ROOT_TEXT } from "../callbacks/reprocess.ts";

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
