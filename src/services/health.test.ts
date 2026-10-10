import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { Agent } from "undici";
import { OPENCODE_BASE_URL } from "../data/connections/groq.ts";
import {
  HealthMonitor,
  modelsUrlFor,
  type Upstream,
  upstreams,
} from "./health.ts";

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
  for await (const chunk of req) chunks.push(chunk as Buffer);
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
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

function monitor(
  targets: Upstream[],
  over: {
    notify?: (text: string) => Promise<void>;
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
) {
  const notices: string[] = [];
  const health = new HealthMonitor(
    targets,
    over.notify ??
      (async (text) => {
        notices.push(text);
      }),
    over.intervalMs,
    over.timeoutMs ?? 1_000,
  );
  return { health, notices };
}

const upOf = (health: HealthMonitor, name: string) =>
  health.snapshot().find((status) => status.name === name)?.up;

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
    list.map((upstream) => upstream.name),
    ["anthropic", "telegram", "obsidian", "parakeet"],
  );
});

test("upstreams sends each key only to its own host", () => {
  const agent = new Agent();
  const list = upstreams(all, agent);
  const byName = new Map(list.map((upstream) => [upstream.name, upstream]));
  // the whole entry: the key's host, the key, and the 2xx a rejected key fails on
  assert.deepEqual(byName.get("groq"), {
    name: "groq",
    url: "https://api.groq.com/openai/v1/models",
    headers: { Authorization: "Bearer gsk-test" },
    requireOk: true,
  });
  assert.deepEqual(byName.get("opencode"), {
    name: "opencode",
    url: `${OPENCODE_BASE_URL}/models`,
    headers: { Authorization: "Bearer oc-test" },
    requireOk: true,
  });
  assert.equal(byName.get("anthropic")?.headers, undefined);
  assert.equal(byName.get("telegram")?.headers, undefined);
  assert.equal(byName.get("parakeet")?.url, "http://parakeet:5092/v1/models");
  // Obsidian goes through the client's own dispatcher (its TLS decision), nobody else does
  assert.equal(byName.get("obsidian")?.dispatcher, agent);
  assert.equal(byName.get("groq")?.dispatcher, undefined);
});

// The owner's hard rule: a health check never spends a token. Every probe URL has to be
// a bare host or a model listing; anything that looks like a generating endpoint fails.
test("no probe targets an endpoint that generates anything", () => {
  for (const upstream of upstreams(all, new Agent())) {
    const path = new URL(upstream.url).pathname;
    assert.doesNotMatch(
      path,
      /completions|messages|chat|audio|transcri|translat|responses|embeddings|generate|query/i,
      `${upstream.name} probes ${upstream.url}`,
    );
    assert.ok(
      path === "/" || path.endsWith("/models"),
      `${upstream.name} probes ${upstream.url}, not a host or a /models listing`,
    );
  }
});

test("a probe is a GET with no body, carrying its target's headers", async () => {
  seen.length = 0;
  const { health } = monitor([
    { name: "a", url: `${base}/ok`, headers: { Authorization: "Bearer k" } },
  ]);
  await health.check();
  assert.deepEqual(
    seen.map((request) => [request.method, request.body, request.auth]),
    [["GET", 0, "Bearer k"]],
  );
});

test("down after 2 failed probes, up on the first success, one notice each", async () => {
  flaky.status = 503;
  const { health, notices } = monitor([
    { name: "groq", url: `${base}/flaky`, requireOk: true },
  ]);

  await health.check();
  assert.equal(
    upOf(health, "groq"),
    true,
    "one failure is a blip, not an outage",
  );
  assert.equal(health.snapshot()[0]!.failures, 1);
  assert.equal(notices.length, 0);

  await health.check();
  assert.equal(upOf(health, "groq"), false);
  assert.equal(health.snapshot()[0]!.error, "HTTP 503");
  await health.check(); // still down: no second notice
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /groq is unreachable: HTTP 503/);

  flaky.status = 200;
  await health.check();
  assert.equal(upOf(health, "groq"), true);
  const status = health.snapshot()[0]!;
  assert.equal(status.failures, 0);
  assert.equal(status.error, null);
  assert.equal(typeof status.latencyMs, "number");
  await health.check(); // still up: no second notice
  assert.equal(notices.length, 2);
  assert.match(notices[1]!, /groq is back/);
});

test("any HTTP answer is reachable unless the upstream needs a 2xx", async () => {
  const { health } = monitor([
    { name: "anthropic", url: `${base}/missing` },
    { name: "groq", url: `${base}/missing`, requireOk: true },
  ]);
  await health.check();
  await health.check();
  assert.equal(upOf(health, "anthropic"), true);
  assert.equal(upOf(health, "groq"), false);
});

test("a probe that never answers times out as a failure", async () => {
  const { health } = monitor([{ name: "slow", url: `${base}/stall` }], {
    timeoutMs: 50,
  });
  const started = Date.now();
  await health.check();
  assert.ok(Date.now() - started < 1_000, "the timeout bounds the round");
  const status = health.snapshot()[0]!;
  assert.equal(status.failures, 1);
  assert.match(status.error ?? "", /timeout|abort/i);
});

test("a failing notifier never throws out of a round", async () => {
  const { health } = monitor([{ name: "dead", url: "http://127.0.0.1:1/" }], {
    notify: async () => {
      throw new Error("telegram down too");
    },
  });
  await health.check();
  await health.check();
  assert.equal(upOf(health, "dead"), false);
  // the cause is what says why: undici's own message is only "fetch failed"
  assert.match(health.snapshot()[0]!.error ?? "", /^fetch failed: \S/);
});

test("a refused dual-stack host is reported by its error code", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  const dualStack = new Agent({
    autoSelectFamily: true,
    connect: {
      lookup: (_host, _options, done) =>
        // IPv4 first: the aggregate takes the first attempt's code, and a host with no
        // IPv6 answers ::1 with EAFNOSUPPORT rather than a refusal.
        (done as unknown as (err: null, found: object[]) => void)(null, [
          { address: "127.0.0.1", family: 4 },
          { address: "::1", family: 6 },
        ]),
    },
  });
  const { health } = monitor([
    {
      name: "dead",
      url: `http://dual.invalid:${port}/`,
      dispatcher: dualStack,
    },
  ]);
  await health.check();
  await dualStack.close();
  assert.match(
    health.snapshot()[0]!.error ?? "",
    /^fetch failed: \S*ECONNREFUSED/,
  );
});

test("start probes on a timer and stop ends it", async () => {
  seen.length = 0;
  const { health } = monitor([{ name: "a", url: `${base}/ok` }], {
    intervalMs: 20,
  });
  health.start();
  await new Promise((resolve) => setTimeout(resolve, 90));
  health.stop();
  // A probe already in flight at stop() still reaches the server; let it before counting.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const count = seen.length;
  assert.ok(count >= 2, `expected repeated probes, saw ${count}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(seen.length, count, "no probe after stop");
});

test("modelsUrlFor swaps the transcription path for the model listing", () => {
  assert.equal(
    modelsUrlFor("http://parakeet:5092/v1/audio/transcriptions"),
    "http://parakeet:5092/v1/models",
  );
  assert.equal(
    modelsUrlFor("http://parakeet:5092/v1/audio/transcriptions/?x=1"),
    "http://parakeet:5092/v1/models",
  );
  assert.equal(modelsUrlFor("http://asr:9000"), "http://asr:9000/models");
});
