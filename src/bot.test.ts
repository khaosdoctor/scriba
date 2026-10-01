import assert from "node:assert/strict";
import { test } from "node:test";
import { ScribaBot } from "./bot.ts";
import { testConfig } from "./test/config.ts";

test("askTil hands the jot and its text to the TIL flow", async () => {
  const bot: any = new ScribaBot(
    testConfig,
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
