import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

test("a bad environment is logged as an invalid config and exits 1 before anything boots", async () => {
  const result = await run(
    process.execPath,
    ["--import", "tsx", "src/index.ts"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { PATH: process.env.PATH, LOG_JSON: "1" },
    },
  ).then(
    () => assert.fail("index.ts exited 0 with an empty environment"),
    (err: { code: number; stdout: string }) => err,
  );

  assert.equal(result.code, 1);
  const lines = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 50);
  assert.equal(lines[0].ns, "config");
  assert.equal(lines[0].msg, "invalid config");
  assert.match(lines[0].issues, /TELEGRAM_BOT_TOKEN/);
});
