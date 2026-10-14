import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { Agent } from "undici";
import { OPENCODE_BASE_URL } from "../data/connections/groq.ts";
import {
  HealthCheck,
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

const checker = (targets: Upstream[], timeoutMs = 1_000) =>
  new HealthCheck(targets, timeoutMs);

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
  await checker([
    { name: "a", url: `${base}/ok`, headers: { Authorization: "Bearer k" } },
  ]).check();
  assert.deepEqual(
    seen.map((request) => [request.method, request.body, request.auth]),
    [["GET", 0, "Bearer k"]],
  );
});

test("one check probes every upstream once and reports each", async () => {
  seen.length = 0;
  flaky.status = 503;
  const rows = await checker([
    { name: "ok", url: `${base}/ok` },
    { name: "groq", url: `${base}/flaky`, requireOk: true },
  ]).check();
  assert.equal(seen.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.name, row.up, row.error]),
    [
      ["ok", true, null],
      ["groq", false, "HTTP 503"],
    ],
  );
  assert.equal(typeof rows[0]!.latencyMs, "number");
  flaky.status = 200;
});

test("any HTTP answer is reachable unless the upstream needs a 2xx", async () => {
  const rows = await checker([
    { name: "anthropic", url: `${base}/missing` },
    { name: "groq", url: `${base}/missing`, requireOk: true },
  ]).check();
  assert.deepEqual(
    rows.map((row) => row.up),
    [true, false],
  );
});

test("a probe that never answers times out as a failure", async () => {
  const started = Date.now();
  const [row] = await checker(
    [{ name: "slow", url: `${base}/stall` }],
    50,
  ).check();
  assert.ok(Date.now() - started < 1_000, "the timeout bounds the check");
  assert.equal(row!.up, false);
  assert.match(row!.error ?? "", /timeout|abort/i);
});

test("a refused host reports the cause, not just fetch failed", async () => {
  const [row] = await checker([
    { name: "dead", url: "http://127.0.0.1:1/" },
  ]).check();
  assert.equal(row!.up, false);
  assert.match(row!.error ?? "", /^fetch failed: \S/);
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
  const [row] = await checker([
    {
      name: "dead",
      url: `http://dual.invalid:${port}/`,
      dispatcher: dualStack,
    },
  ]).check();
  await dualStack.close();
  assert.match(row!.error ?? "", /^fetch failed: \S*ECONNREFUSED/);
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
