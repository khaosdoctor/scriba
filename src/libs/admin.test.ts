import assert from "node:assert/strict";
import { test } from "node:test";
import type { Stats } from "../domain/jot/structures.ts";
import type { ReleaseNote } from "../domain/release/structures.ts";
import {
  formatDeployNotice,
  formatHealth,
  formatListPage,
  formatReleaseList,
  formatReleaseNote,
  formatStats,
  formatStatus,
} from "./admin.ts";

const DASH = String.fromCharCode(0x2014);

test("formatStats hides zero outcome tails", () => {
  const base: Stats = {
    total: 4,
    text: 3,
    audio: 1,
    image: 0,
    video: 0,
    done: 4,
    failed: 0,
    abandoned: 0,
    inflight: 0,
  };
  const clean = formatStats("today", base);
  assert.match(clean, /Jots: 4/);
  assert.match(clean, /voice 1/);
  assert.equal(clean.includes("failed"), false); // no failures → no tail
  const withFail = formatStats("today", { ...base, failed: 2, inflight: 1 });
  assert.match(withFail, /in-flight 1 · failed 2/);
});

function fakeRelease(over: Partial<ReleaseNote> = {}): ReleaseNote {
  return {
    tag: "v1.2.3",
    version: "1.2.3",
    name: "v1.2.3",
    body: "### Bug Fixes\n\n* fixed the thing",
    url: "https://github.com/khaosdoctor/scriba/releases/tag/v1.2.3",
    publishedAt: "2026-07-15T20:03:58Z",
    ...over,
  };
}

test("formatDeployNotice reports version and sha with no release note", () => {
  const out = formatDeployNotice("1.2.3", "abcdef1234", null);
  assert.equal(out, `🚀 scriba deployed ${DASH} 1.2.3 (abcdef1)`);
});

test("formatDeployNotice includes the release body and link when a note is given", () => {
  const out = formatDeployNotice("1.2.3", "abcdef1234", fakeRelease());
  assert.match(
    out,
    new RegExp(`scriba deployed ${DASH} 1\\.2\\.3 \\(abcdef1\\)`),
  );
  assert.match(out, /fixed the thing/);
  assert.match(out, /releases\/tag\/v1\.2\.3/);
});

test("formatReleaseNote shows the release name, body, and link", () => {
  const out = formatReleaseNote(
    fakeRelease({ name: "Better fallback errors" }),
  );
  assert.match(out, /📋 Better fallback errors/);
  assert.match(out, /fixed the thing/);
  assert.match(out, /releases\/tag\/v1\.2\.3/);
});

test("formatReleaseNote strips conventional-changelog markdown from the body", () => {
  const body =
    "### Features\n\n" +
    "* add /changelog command and put what's new in the deploy notice ([b95325e](https://github.com/khaosdoctor/scriba/commit/b95325e6721e0e63d502c8642208b9cd0a001a4f))\n\n" +
    "### Bug Fixes\n\n" +
    "* stop asserting usage exhaustion as the cause of enrichment fallback ([#9](https://github.com/khaosdoctor/scriba/issues/9)) ([ff223cd](https://github.com/khaosdoctor/scriba/commit/ff223cdc1092eaa683352258ddb8eb93abc5fd8b))";
  const out = formatReleaseNote(fakeRelease({ body }));
  assert.equal(
    out,
    [
      "📋 v1.2.3",
      [
        "Features:",
        "• add /changelog command and put what's new in the deploy notice",
      ].join("\n"),
      [
        "Bug Fixes:",
        "• stop asserting usage exhaustion as the cause of enrichment fallback",
      ].join("\n"),
      "https://github.com/khaosdoctor/scriba/releases/tag/v1.2.3",
    ].join("\n\n"),
  );
  assert.doesNotMatch(out, /###|\[|\]|\(https/);
});

test("formatReleaseList summarises releases newest-first, and handles an empty list", () => {
  const out = formatReleaseList([
    fakeRelease({ tag: "v1.2.3", publishedAt: "2026-07-15T12:00:00Z" }),
    fakeRelease({ tag: "v1.2.2", publishedAt: "2026-07-10T12:00:00Z" }),
  ]);
  assert.match(out, /• v1\.2\.3 \(2026-07-15\)/);
  assert.match(out, /• v1\.2\.2 \(2026-07-10\)/);
  assert.equal(formatReleaseList([]), "no releases found");
});

test("formatStatus summarises health", () => {
  const out = formatStatus({
    counts: {
      pending: 1,
      processing: 1,
      done: 10,
      failed: 2,
      abandoned: 0,
      deleted: 0,
    },
    queueDepth: 3,
    transcriber: "local",
    links: { enabled: true, files: 5, aliases: 9 },
    version: "1.2.3",
    sha: "abcdef1234",
    uptimeMs: 90_000,
  });
  assert.match(out, /scriba 1\.2\.3 \(abcdef1\)/);
  assert.match(out, /10 done · 2 in-flight · 2 failed/); // pending+processing = in-flight
  assert.match(out, /Queue depth: 3/);
  assert.match(out, /Transcriber: local/);
  assert.match(out, /5 files \/ 9 aliases/);
});

test("formatHealth renders one line per upstream", () => {
  const now = 1_000_000;
  const out = formatHealth(
    [
      {
        name: "anthropic",
        up: true,
        latencyMs: 120,
        error: null,
        failures: 0,
        since: 0,
      },
      {
        name: "groq",
        up: false,
        latencyMs: 5001,
        error: "HTTP 401",
        failures: 3,
        since: now - 180_000,
      },
      {
        name: "parakeet",
        up: true,
        latencyMs: null,
        error: null,
        failures: 0,
        since: now,
      },
    ],
    now,
  );
  assert.deepEqual(out.split("\n"), [
    "Upstreams:",
    "🟢 anthropic · 120 ms",
    "🔴 groq · down 3m 0s · 5001 ms · HTTP 401",
    "🟢 parakeet · not probed yet",
  ]);
});

test("formatHealth caps a long error", () => {
  const out = formatHealth(
    [
      {
        name: "obsidian",
        up: true,
        latencyMs: 40,
        error: "x ".repeat(200),
        failures: 1,
        since: 0,
      },
    ],
    0,
  );
  assert.ok(out.split("\n")[1]!.length < 180);
  // one failed probe is a warning, not green
  assert.ok(out.split("\n")[1]!.startsWith("🟡 obsidian"));
});

test("formatStatus shows a disabled link index", () => {
  const out = formatStatus({
    counts: {
      pending: 0,
      processing: 0,
      done: 0,
      failed: 0,
      abandoned: 0,
      deleted: 0,
    },
    queueDepth: 0,
    transcriber: "remote",
    links: { enabled: false, files: 0, aliases: 0 },
    version: "1",
    sha: "0000000",
    uptimeMs: 0,
  });
  assert.match(out, /Link index: disabled/);
});

test("formatListPage clamps the page and footers what is off screen", () => {
  const items = Array.from({ length: 5 }, (_, index) => `item${index + 1}`);
  // One page fits: no footer at all.
  assert.equal(formatListPage(items, 0, 10, "/x"), items.join("\n"));

  const first = formatListPage(items, 0, 2, "/x");
  assert.match(first, /^item1\nitem2\n\n/);
  assert.match(first, /Showing 1–2 of 5 · page 1\/3 · next: \/x 2$/);

  // Last page is short and points back to the start rather than a page that isn't there.
  const last = formatListPage(items, 2, 2, "/x");
  assert.match(last, /^item5\n\n/);
  assert.match(
    last,
    /Showing 5–5 of 5 · page 3\/3 · back to the start: \/x 1$/,
  );

  // Out-of-range pages clamp instead of rendering an empty body.
  assert.equal(formatListPage(items, 99, 2, "/x"), last);
  assert.equal(formatListPage(items, -3, 2, "/x"), first);

  // A custom separator keeps the footer on its own line.
  assert.match(formatListPage(items, 0, 2, "/x", ", "), /^item1, item2\n\n/);
});
