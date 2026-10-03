import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "undici";
import { ObsidianConnection } from "./obsidian.ts";

const connect = (url: string, insecureTls = false) =>
  new ObsidianConnection({ url, key: "hunter2", insecureTls });

test("every loopback spelling and a LAN host get a dispatcher", () => {
  for (const url of [
    "https://127.0.0.1:27124",
    "https://localhost:27124",
    "https://[::1]:27124",
    "https://obsidian.lan:27124",
  ])
    assert.ok(connect(url).dispatcher instanceof Agent);
  assert.ok(
    connect("https://obsidian.lan:27124", true).dispatcher instanceof Agent,
  );
});
