import assert from "node:assert/strict";
import { test } from "node:test";
import { ObsidianConnection } from "./obsidian.ts";

const connect = (url: string, insecureTls = false) =>
  new ObsidianConnection({ url, key: "hunter2", insecureTls });

test("a loopback Obsidian skips TLS verification, every spelling of it", () => {
  for (const url of [
    "https://127.0.0.1:27124",
    "https://localhost:27124",
    "https://[::1]:27124",
  ])
    assert.equal(connect(url).verifyTls, false, url);
});

test("a LAN Obsidian verifies TLS unless OBSIDIAN_INSECURE_TLS opts out", () => {
  assert.equal(connect("https://obsidian.lan:27124").verifyTls, true);
  assert.equal(connect("https://obsidian.lan:27124", true).verifyTls, false);
});
