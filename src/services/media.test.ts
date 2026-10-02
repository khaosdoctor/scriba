import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaService } from "./media.ts";

const service = (file: { file_path?: string }) =>
  new MediaService({
    api: { getFile: async () => file },
    token: "t",
    transcriber: { transcribe: async () => "" },
  });

test("a Telegram file is downloaded with its extension and mime type", async (testContext) => {
  const urls: string[] = [];
  testContext.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const file = await service({ file_path: "voice/file_1.OGA" }).downloadFile(
    "f1",
  );
  assert.deepEqual(urls, [
    "https://api.telegram.org/file/bott/voice/file_1.OGA",
  ]);
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(file.ext, "oga");
  assert.equal(file.mime, "audio/ogg");

  const other = await service({ file_path: "documents/file_2" }).downloadFile(
    "f2",
  );
  assert.equal(other.ext, "bin");
  assert.equal(other.mime, "application/octet-stream");
});

test("a file Telegram will not serve fails the download with its reason", async (testContext) => {
  await assert.rejects(
    () => service({}).downloadFile("f1"),
    /no file_path for f1/,
  );
  testContext.mock.method(
    globalThis,
    "fetch",
    async () => new Response("no", { status: 404 }),
  );
  await assert.rejects(
    () => service({ file_path: "voice/a.oga" }).downloadFile("f1"),
    /telegram file download: 404/,
  );
});
