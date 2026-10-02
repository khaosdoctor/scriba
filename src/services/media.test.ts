import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaService } from "./media.ts";

const service = (path: string) =>
  new MediaService({
    files: {
      download: async () => ({ path, bytes: new Uint8Array([1, 2, 3]) }),
    },
  });

test("a Telegram file is downloaded with its extension and mime type", async () => {
  const file = await service("voice/file_1.OGA").downloadFile("f1");
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(file.ext, "oga");
  assert.equal(file.mime, "audio/ogg");

  const other = await service("documents/file_2").downloadFile("f2");
  assert.equal(other.ext, "bin");
  assert.equal(other.mime, "application/octet-stream");
});
