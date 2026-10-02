import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramFiles } from "./telegram-files.ts";

const files = (file: { file_path?: string }) =>
  new TelegramFiles({ getFile: async () => file }, "t");

test("a Telegram file is fetched from the token URL with its path", async (testContext) => {
  const urls: string[] = [];
  testContext.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const file = await files({ file_path: "voice/file_1.OGA" }).download("f1");
  assert.deepEqual(urls, [
    "https://api.telegram.org/file/bott/voice/file_1.OGA",
  ]);
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(file.path, "voice/file_1.OGA");
});

test("a file Telegram will not serve fails the download with its reason", async (testContext) => {
  await assert.rejects(() => files({}).download("f1"), /no file_path for f1/);
  testContext.mock.method(
    globalThis,
    "fetch",
    async () => new Response("no", { status: 404 }),
  );
  await assert.rejects(
    () => files({ file_path: "voice/a.oga" }).download("f1"),
    /telegram file download: 404/,
  );
});
