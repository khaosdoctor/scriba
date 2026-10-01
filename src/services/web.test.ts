import assert from "node:assert/strict";
import { test } from "node:test";
import { MockAgent } from "undici";
import { isPrivateAddress, publicLookup, WebService } from "./web.ts";

const ORIGIN = "http://93.184.216.34";

function fixture() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return { pool: agent.get(ORIGIN), web: new WebService(agent) };
}

const html = { headers: { "content-type": "text/html" } };

test("web_fetch refuses anything that isn't a public http(s) page", async () => {
  const { web } = fixture();
  for (const bad of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "data:text/html,hi",
  ])
    await assert.rejects(() => web.fetchPage(bad), /only http\(s\)/);
  await assert.rejects(
    () => web.fetchPage("http://localhost:8080/health"),
    /private address/,
  );
  await assert.rejects(
    () => web.fetchPage("http://127.0.0.1/"),
    /private address/,
  );
  await assert.rejects(() => web.fetchPage("not a url"), /not a URL/);
  await assert.rejects(
    () => web.fetchPage("http://scriba-no-such-host.invalid/"),
    /cannot resolve scriba-no-such-host\.invalid/,
  );
});

test("isPrivateAddress covers loopback, RFC1918, link-local and CGNAT", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.50.125", // the homelab itself
    "172.16.0.1",
    "172.31.255.255",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "febf::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);

  for (const ip of [
    "1.1.1.1",
    "8.8.8.8",
    "172.32.0.1",
    "192.169.0.1",
    "2606:4700::1111",
    "fec0::1",
  ])
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
});

test("the connection itself refuses a host that resolves to a private address", async () => {
  const dial = (host: string, all: boolean) =>
    new Promise<unknown>((resolve, reject) =>
      publicLookup(host, { all }, (err, address, family) =>
        err ? reject(err) : resolve(all ? address : [address, family]),
      ),
    );
  await assert.rejects(
    dial("127.0.0.1", true),
    /refusing to connect to 127\.0\.0\.1: it resolves to a private address \(127\.0\.0\.1\)/,
  );
  assert.deepEqual(await dial("93.184.216.34", false), ["93.184.216.34", 4]);
  assert.deepEqual(await dial("93.184.216.34", true), [
    { address: "93.184.216.34", family: 4 },
  ]);
});

test("web_fetch returns an HTML page as plain text", async () => {
  const { pool, web } = fixture();
  pool
    .intercept({ path: "/a" })
    .reply(200, "<html><body><p>hello <b>web</b></p></body></html>", html);
  assert.match(await web.fetchPage(`${ORIGIN}/a`), /hello web/);
});

test("web_fetch re-checks every redirect hop and refuses one into the LAN", async () => {
  const { pool, web } = fixture();
  pool.intercept({ path: "/ok" }).reply(302, "", {
    headers: { location: "/next" },
  });
  pool.intercept({ path: "/next" }).reply(200, "<p>arrived</p>", html);
  assert.match(await web.fetchPage(`${ORIGIN}/ok`), /arrived/);

  pool.intercept({ path: "/evil" }).reply(302, "", {
    headers: { location: "http://192.168.1.1/admin" },
  });
  await assert.rejects(
    () => web.fetchPage(`${ORIGIN}/evil`),
    /192\.168\.1\.1: it resolves to a private address/,
  );
});

test("web_fetch gives up after five redirects", async () => {
  const { pool, web } = fixture();
  pool
    .intercept({ path: "/loop" })
    .reply(302, "", { headers: { location: "/loop" } })
    .times(6);
  await assert.rejects(
    () => web.fetchPage(`${ORIGIN}/loop`),
    /too many redirects/,
  );
});

test("web_fetch rejects an error status, a non-text body and an oversized page", async () => {
  const { pool, web } = fixture();
  pool.intercept({ path: "/gone" }).reply(404, "nope", html);
  await assert.rejects(
    () => web.fetchPage(`${ORIGIN}/gone`),
    /fetch failed: HTTP 404/,
  );

  pool
    .intercept({ path: "/img" })
    .reply(200, "x", { headers: { "content-type": "image/png" } });
  await assert.rejects(
    () => web.fetchPage(`${ORIGIN}/img`),
    /not a text page \(content-type: image\/png\)/,
  );

  pool
    .intercept({ path: "/untyped" })
    .reply(200, "x", { headers: { "content-type": "" } });
  await assert.rejects(
    () => web.fetchPage(`${ORIGIN}/untyped`),
    /content-type: unknown/,
  );

  pool.intercept({ path: "/big" }).reply(200, "x", {
    headers: { "content-type": "text/plain", "content-length": "5000000" },
  });
  await assert.rejects(
    () => web.fetchPage(`${ORIGIN}/big`),
    /page too large \(5000000 bytes\)/,
  );
});

test("web_fetch truncates a long text page at 200000 characters", async () => {
  const { pool, web } = fixture();
  pool.intercept({ path: "/long" }).reply(200, "a".repeat(250_000), {
    headers: { "content-type": "text/plain" },
  });
  const text = await web.fetchPage(`${ORIGIN}/long`);
  assert.equal(text, `${"a".repeat(200_000)}\n… (truncated)`);
});

test("web_fetch stops reading at 4 MB when the page sends no Content-Length", async () => {
  const { pool, web } = fixture();
  pool
    .intercept({ path: "/endless" })
    .reply(200, `${"<i></i>".repeat(600_000)}tail`, html);
  assert.doesNotMatch(await web.fetchPage(`${ORIGIN}/endless`), /tail/);
});
