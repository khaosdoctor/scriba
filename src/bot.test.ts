import assert from "node:assert/strict";
import { test } from "node:test";

// config.ts reads process.env at import time, so the bot is imported after these are set.
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.ALLOWED_TELEGRAM_USER_ID = "1";
process.env.OBSIDIAN_API_KEY = "o";

test("askTil hands the jot and its text to the TIL flow", async () => {
  const { ScribaBot } = await import("./bot.ts");
  const bot: any = new ScribaBot(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const asks: [string, string][] = [];
  bot.jotController.askTil = async (id: string, text: string) =>
    void asks.push([id, text]);
  assert.equal(await bot.askTil("abcd1234", "TIL: x"), undefined);
  assert.deepEqual(asks, [["abcd1234", "TIL: x"]]);
});
