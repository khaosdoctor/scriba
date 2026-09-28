import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { Agent } from "undici";
import { HealthMonitor, type Upstream, upstreams } from "./health.ts";

/**
 * The upstreams, played by one loopback server so the monitor's real fetch, timeout and
 * status handling run instead of a stubbed `fetch`. The path picks the behaviour:
 * `/ok` answers 200, `/missing` 404, `/flaky` whatever `flaky.status` says, `/stall`
 * never answers. Every request is recorded, body length included.
 */
const flaky = { status: 200 };
const seen: { method: string; path: string; auth?: string; body: number }[] =
  [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  seen.push({
    method: req.method ?? "",
    path: req.url ?? "",
    auth: req.headers.authorization,
    body: Buffer.concat(chunks).length,
  });
  if (req.url === "/stall") return; // held open until the client gives up
  if (req.url === "/ok") return void res.writeHead(200).end("{}");
  if (req.url === "/missing") return void res.writeHead(404).end("nope");
  if (req.url === "/flaky") return void res.writeHead(flaky.status).end();
  res.writeHead(500).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

function monitor(
  targets: Upstream[],
  over: {
    notify?: (t: string) => Promise<void>;
    onChange?: (name: string, up: boolean) => void;
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
) {
  const notices: string[] = [];
  const changes: [string, boolean][] = [];
  const m = new HealthMonitor(
    targets,
    over.notify ??
      (async (t) => {
        notices.push(t);
      }),
    over.onChange ?? ((name, up) => void changes.push([name, up])),
    over.intervalMs,
    over.timeoutMs ?? 1_000,
  );
  return { m, notices, changes };
}

const all = {
  groqApiKey: "gsk-test",
  opencodeApiKey: "oc-test",
  obsidianUrl: "https://127.0.0.1:27124",
  parakeetUrl: "http://parakeet:5092/v1/audio/transcriptions",
};

test("upstreams skips Groq and OpenCode without a key", () => {
  const list = upstreams(
    { ...all, groqApiKey: "", opencodeApiKey: "" },
    new Agent(),
  );
  assert.deepEqual(
    list.map((u) => u.name),
    ["anthropic", "telegram", "obsidian", "parakeet"],
  );
});

test("upstreams sends each key only to its own host", () => {
  const list = upstreams(all, new Agent());
  const byName = new Map(list.map((u) => [u.name, u]));
  assert.equal(byName.get("groq")?.headers?.Authorization, "Bearer gsk-test");
  assert.equal(
    byName.get("opencode")?.headers?.Authorization,
    "Bearer oc-test",
  );
  assert.equal(byName.get("anthropic")?.headers, undefined);
  assert.equal(byName.get("telegram")?.headers, undefined);
  assert.equal(byName.get("parakeet")?.url, "http://parakeet:5092/v1/models");
});

// The owner's hard rule: a health check never spends a token. Every probe URL has to be
// a bare host or a model listing; anything that looks like a generating endpoint fails.
test("no probe targets an endpoint that generates anything", () => {
  for (const u of upstreams(all, new Agent())) {
    const path = new URL(u.url).pathname;
    assert.doesNotMatch(
      path,
      /completions|messages|chat|audio|transcri|translat|responses|embeddings|generate|query/i,
      `${u.name} probes ${u.url}`,
    );
    assert.ok(
      path === "/" || path.endsWith("/models"),
      `${u.name} probes ${u.url}, not a host or a /models listing`,
    );
  }
});

test("a probe is a GET with no body", async () => {
  seen.length = 0;
  const { m } = monitor([{ name: "a", url: `${base}/ok` }]);
  await m.check();
  assert.deepEqual(
    seen.map((s) => [s.method, s.body]),
    [["GET", 0]],
  );
});

test("down after 2 failed probes, up on the first success, one notice each", async () => {
  flaky.status = 503;
  const { m, notices, changes } = monitor([
    { name: "groq", url: `${base}/flaky`, requireOk: true },
  ]);

  await m.check();
  assert.equal(m.isUp("groq"), true, "one failure is a blip, not an outage");
  assert.equal(m.snapshot()[0]!.failures, 1);
  assert.equal(notices.length, 0);

  await m.check();
  assert.equal(m.isUp("groq"), false);
  assert.equal(m.snapshot()[0]!.error, "HTTP 503");
  await m.check(); // still down: no second notice
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /groq is unreachable: HTTP 503/);

  flaky.status = 200;
  await m.check();
  assert.equal(m.isUp("groq"), true);
  const s = m.snapshot()[0]!;
  assert.equal(s.failures, 0);
  assert.equal(s.error, null);
  assert.equal(typeof s.latencyMs, "number");
  await m.check(); // still up: no second notice
  assert.equal(notices.length, 2);
  assert.match(notices[1]!, /groq is back/);
  assert.deepEqual(changes, [
    ["groq", false],
    ["groq", true],
  ]);
});

test("any HTTP answer is reachable unless the upstream needs a 2xx", async () => {
  const { m } = monitor([
    { name: "anthropic", url: `${base}/missing` },
    { name: "groq", url: `${base}/missing`, requireOk: true },
  ]);
  await m.check();
  await m.check();
  assert.equal(m.isUp("anthropic"), true);
  assert.equal(m.isUp("groq"), false);
});

test("a probe that never answers times out as a failure", async () => {
  const { m } = monitor([{ name: "slow", url: `${base}/stall` }], {
    timeoutMs: 50,
  });
  const started = Date.now();
  await m.check();
  assert.ok(Date.now() - started < 1_000, "the timeout bounds the round");
  const s = m.snapshot()[0]!;
  assert.equal(s.failures, 1);
  assert.match(s.error ?? "", /timeout|abort/i);
});

test("a round still running makes the next tick a no-op", async () => {
  seen.length = 0;
  const { m } = monitor([{ name: "slow", url: `${base}/stall` }], {
    timeoutMs: 100,
  });
  const first = m.check();
  await m.check(); // returns straight away, sends nothing
  await first;
  assert.equal(seen.filter((s) => s.path === "/stall").length, 1);
});

test("a failing notifier or listener never throws out of a round", async () => {
  const { m } = monitor([{ name: "dead", url: "http://127.0.0.1:1/" }], {
    notify: async () => {
      throw new Error("telegram down too");
    },
    onChange: () => {
      throw new Error("listener bug");
    },
  });
  await m.check();
  await m.check();
  assert.equal(m.isUp("dead"), false);
  assert.match(m.snapshot()[0]!.error ?? "", /fetch failed/);
});

test("isUp is true for an upstream nobody probes", () => {
  const { m } = monitor([]);
  assert.equal(m.isUp("groq"), true);
});

test("start probes on a timer and stop ends it", async () => {
  seen.length = 0;
  const { m } = monitor([{ name: "a", url: `${base}/ok` }], { intervalMs: 20 });
  m.start();
  await new Promise((r) => setTimeout(r, 90));
  m.stop();
  // A probe already in flight at stop() still reaches the server; let it before counting.
  await new Promise((r) => setTimeout(r, 50));
  const count = seen.length;
  assert.ok(count >= 2, `expected repeated probes, saw ${count}`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen.length, count, "no probe after stop");
});
