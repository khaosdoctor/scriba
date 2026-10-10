import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingDecisions } from "./pending.ts";

test("a timeout settles with the fallback and reports once", async () => {
  const pending = new PendingDecisions<string>({ clearAndUnref: true });
  const seen: string[] = [];
  // The wait's own timer is unref'd, so with nothing else pending the event loop would
  // drain before it fires and the runner would cancel the test: hold the loop open.
  const keepAlive = setTimeout(() => {}, 1_000);
  const value = await pending.wait("a", 5, "late", () => seen.push("timeout"));
  clearTimeout(keepAlive);
  assert.equal(value, "late");
  assert.deepEqual(seen, ["timeout"]);
  assert.equal(pending.take("a"), undefined);
});

test("take hands back the settle function once", async () => {
  const pending = new PendingDecisions<string>({ clearAndUnref: true });
  const decision = pending.wait("a", 60_000, "late", () => {});
  assert.equal(pending.size, 1);
  pending.take("a")?.("tapped");
  assert.equal(await decision, "tapped");
  assert.equal(pending.size, 0);
  assert.equal(pending.take("a"), undefined);
});

test("settleAll answers every waiter", async () => {
  const pending = new PendingDecisions<boolean>({ clearAndUnref: true });
  const first = pending.wait("a", 60_000, true, () => {});
  const second = pending.wait("b", 60_000, true, () => {});
  assert.equal(pending.size, 2);
  pending.settleAll(false);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(pending.size, 0);
});

test("without clearAndUnref a taken entry's timer stays armed but does nothing", async () => {
  const pending = new PendingDecisions<string>({ clearAndUnref: false });
  const seen: string[] = [];
  const decision = pending.wait("a", 5, "late", () => seen.push("timeout"));
  pending.take("a")?.("tapped");
  assert.equal(await decision, "tapped");
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(seen, []);
});
