import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness } from "../../test/bot-harness.ts";
import { ROOT_TEXT } from "../callbacks/reprocess.ts";

test("/reprocess opens the scope picker with a Close button", async () => {
  const h = await botHarness();
  const run = await h.say("/reprocess");
  assert.deepEqual(run.texts("sendMessage"), [ROOT_TEXT]);
  assert.deepEqual(
    run.calls[0]?.payload.reply_markup.inline_keyboard
      .flat()
      .map((b: { text: string; callback_data: string }) => [
        b.text,
        b.callback_data,
      ]),
    [
      ["📅 One day", "rp:day"],
      ["📆 Date range", "rp:range"],
      ["✉️ One jot", "rp:jot:0"],
      ["✖ Close", "rp:close"],
    ],
  );
});
