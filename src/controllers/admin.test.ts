import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../domain/jot/entity.ts";
import type { Stats } from "../domain/jot/structures.ts";
import { dayBounds, startOfToday } from "../libs/time.ts";
import type { ReleaseNote } from "../services/github.ts";
import { sampleJot } from "../test/sqlite.ts";
import {
  AdminController,
  formatDeployNotice,
  formatHealth,
  formatListPage,
  formatReleaseList,
  formatReleaseNote,
  formatStats,
  formatStatus,
} from "./admin.ts";

const DASH = String.fromCharCode(0x2014);

const aJot = (over: Partial<Jot> = {}): Jot =>
  sampleJot("abcd1234", {
    status: "failed",
    attempts: 2,
    raw_text: "a thought",
    note_path: "notes/daily notes/2026-08-16.md",
    received_at: 0,
    error: "fetch failed",
    ...over,
  });

/** A controller with every collaborator recorded on `calls`. Anything a test does not
 *  override throws if touched, so a command reaching for something it should not shows up
 *  as a failure. */
function setup(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const track =
    (name: string, out?: any) =>
    async (...args: any[]) => {
      calls.push(`${name}(${args.join(",")})`);
      return typeof out === "function" ? out(...args) : out;
    };
  const deps = {
    links: {},
    github: {},
    build: { version: "1.34.0", sha: "abc1234" },
    startedAt: Date.now(),
    notifier: { notify: track("notify") },
    ...over,
    // Spread per collaborator, after `over`: overriding one repo method must not drop
    // the rest of the tracked stubs with it.
    repo: {
      getJot: track("getJot", null),
      resetForRetry: track("resetForRetry"),
      resetFailed: track("resetFailed", 0),
      resetProcessing: track("resetProcessing", 0),
      failedJots: track("failedJots", []),
      stopwords: track("stopwords", new Set<string>()),
      addStopword: track("addStopword"),
      delStopword: track("delStopword", 0),
      rejectionList: track("rejectionList", []),
      unreject: track("unreject", 0),
      setSetting: track("setSetting"),
      ...over.repo,
    },
    queue: {
      add: (ids: string[]) => void calls.push(`queue.add(${ids.join(",")})`),
      ...over.queue,
    },
    processing: { retryPass: track("retryPass"), ...over.processing },
    transcriber: { chain: "groq → parakeet", ...over.transcriber },
  };
  return { admin: new AdminController(deps as never), calls };
}

test("/retry with an id resets and queues that jot alone", async () => {
  const { admin, calls } = setup({ repo: { getJot: async () => aJot() } });
  assert.equal(await admin.retry(" ABCD1234 "), "🔄 retrying abcd1234");
  assert.ok(calls.includes("resetForRetry(abcd1234)"));
  assert.ok(calls.includes("queue.add(abcd1234)"));
  // One jot, so the pass isn't kicked for the whole backlog.
  assert.ok(!calls.some((call) => call.startsWith("retryPass")));
});

test("/retry with an unknown id says so instead of queueing nothing", async () => {
  const { admin, calls } = setup();
  assert.equal(await admin.retry("nope"), "no jot nope");
  assert.ok(!calls.some((call) => call.startsWith("resetForRetry")));
});

test("/retry with no args takes the failed ones; `all` includes the abandoned", async () => {
  // An override replaces the tracked stub, so it records its own argument: whether the
  // abandoned jots are retried too is the whole difference between these two calls.
  const scope: boolean[] = [];
  const resetFailed = (count: number) => async (all: boolean) => {
    scope.push(all);
    return count;
  };

  const first = setup({ repo: { resetFailed: resetFailed(3) } });
  assert.equal(await first.admin.retry(""), "🔄 requeued 3 jots");
  assert.ok(first.calls.some((call) => call.startsWith("retryPass")));

  const all = setup({ repo: { resetFailed: resetFailed(1) } });
  assert.equal(
    await all.admin.retry("ALL"),
    "🔄 requeued 1 jot (incl. abandoned)",
  );
  assert.deepEqual(scope, [false, true]);
});

test("/retry doesn't run a pass when nothing was requeued", async () => {
  const { admin, calls } = setup({ repo: { resetFailed: async () => 0 } });
  await admin.retry("");
  assert.ok(!calls.some((call) => call.startsWith("retryPass")));
});

test("/stopword add and del need a word, and say what changed", async () => {
  const add = setup();
  assert.equal(await add.admin.stopwords("add Monday"), '➕ stopword "monday"');
  assert.ok(add.calls.includes("addStopword(Monday)"));
  assert.equal(
    await setup().admin.stopwords("add"),
    "usage: /stopword add <word>",
  );

  const hit = setup({ repo: { delStopword: async () => 1 } });
  assert.equal(await hit.admin.stopwords("del Monday"), '➖ removed "monday"');
  // Nothing removed is not the same as removed, so the reply has to tell them apart.
  assert.equal(
    await setup().admin.stopwords("del Monday"),
    'no stopword "monday"',
  );
});

test("/stopword list paginates, and a bad subcommand gets usage", async () => {
  const words = new Set(
    Array.from({ length: 130 }, (_, index) => `w${index + 1000}`),
  );
  const { admin } = setup({ repo: { stopwords: async () => words } });
  const page1 = await admin.stopwords("list");
  assert.match(page1, /page 1\/3/);
  assert.match(page1, /next: \/stopword list 2/);
  assert.match(await admin.stopwords("list 2"), /page 2\/3/);
  // Out-of-range and junk page numbers clamp rather than answering with a blank page.
  assert.match(await admin.stopwords("list 99"), /page 3\/3/);
  assert.match(await admin.stopwords("list zz"), /page 1\/3/);
  assert.equal(
    await setup().admin.stopwords(""),
    "usage: /stopword add|del|list [word]",
  );
  assert.equal(await setup().admin.stopwords("list"), "(none)");
});

test("/jot needs an id and reports one that isn't there", async () => {
  assert.equal(await setup().admin.jotDetail("  "), "usage: /jot <id>");
  assert.equal(await setup().admin.jotDetail("abcd1234"), "no jot abcd1234");
  const found = await setup({
    repo: { getJot: async () => aJot() },
  }).admin.jotDetail("abcd1234");
  assert.match(found, /abcd1234/);
});

test("/failed says nothing failed, and otherwise lists the jots with their ids", async () => {
  assert.deepEqual(await setup().admin.failed(), {
    text: "✅ nothing failed.",
    ids: [],
  });

  const jots = [aJot(), aJot({ id: "ffff0001", status: "abandoned" })];
  const { text, ids } = await setup({
    repo: { failedJots: async () => jots },
  }).admin.failed();
  assert.match(text, /2 failed/);
  assert.match(text, /abcd1234 \[text\] failed ×2 — fetch failed/);
  assert.deepEqual(ids, ["abcd1234", "ffff0001"]);
});

test("/rejections and /unstick report their counts", async () => {
  assert.equal(await setup().admin.rejections(""), "(no rejections)");
  const listed = await setup({
    repo: {
      rejectionList: async () => [{ surface: "monday", note: "Monday" }],
    },
  }).admin.rejections("");
  assert.equal(listed, '"monday" ✗ [[Monday]]');

  assert.equal(await setup().admin.unstick(), "🔧 unstuck 0 jots");
  assert.equal(
    await setup({ repo: { resetProcessing: async () => 1 } }).admin.unstick(),
    "🔧 unstuck 1 jot",
  );
});

const release = (over: Partial<ReleaseNote> = {}): ReleaseNote => ({
  tag: "v1.34.0",
  version: "1.34.0",
  name: "v1.34.0",
  body: "### Features\n\n* offer to move TIL jots ([#22](https://x/22)) ([abc1234](https://x/abc1234))\n\n### Bug Fixes\n\n* keep the card ([#23](https://x/23))\n",
  url: "https://github.com/o/r/releases/tag/v1.34.0",
  publishedAt: "2026-09-30T12:00:00.000Z",
  ...over,
});

test("/changelog with no args shows the latest release as plain text", async () => {
  const { admin } = setup({ github: { latest: async () => release() } });
  assert.equal(
    await admin.changelog(""),
    "📋 v1.34.0\n\nFeatures:\n• offer to move TIL jots\n\nBug Fixes:\n• keep the card\n\nhttps://github.com/o/r/releases/tag/v1.34.0",
  );
});

test("/changelog says so when GitHub can't be reached", async () => {
  const down = { latest: async () => null, byVersion: async () => null };
  assert.equal(
    await setup({ github: down }).admin.changelog(""),
    "⚠️ couldn't reach GitHub for the latest release",
  );
  assert.equal(
    await setup({ github: down }).admin.changelog("9.9.9"),
    "no release found for 9.9.9",
  );
  assert.equal(
    await setup({ github: { recent: async () => [] } }).admin.changelog("5"),
    "⚠️ couldn't reach GitHub for release history",
  );
});

test("/changelog with a version looks that version up", async () => {
  const asked: string[] = [];
  const { admin } = setup({
    github: {
      byVersion: async (version: string) => {
        asked.push(version);
        return release({ name: "v1.2.3", body: "", url: "https://x/1.2.3" });
      },
    },
  });
  assert.equal(
    await admin.changelog(" 1.2.3 "),
    "📋 v1.2.3\n\nhttps://x/1.2.3",
  );
  assert.deepEqual(asked, ["1.2.3"]);
});

test("/changelog N lists the N most recent releases and clamps N to 1-20", async () => {
  const asked: number[] = [];
  const { admin } = setup({
    github: {
      recent: async (count: number) => {
        asked.push(count);
        return [
          release(),
          release({
            tag: "v1.33.0",
            publishedAt: "2026-09-22T12:00:00.000Z",
            url: "https://github.com/o/r/releases/tag/v1.33.0",
          }),
        ];
      },
    },
  });
  assert.equal(
    await admin.changelog("2"),
    `• v1.34.0 (2026-09-30) ${DASH} https://github.com/o/r/releases/tag/v1.34.0\n• v1.33.0 (2026-09-22) ${DASH} https://github.com/o/r/releases/tag/v1.33.0`,
  );
  await admin.changelog("0");
  await admin.changelog("99");
  assert.deepEqual(asked, [2, 1, 20]);
});

test("/stats asks for the window it names and refuses anything else", async (testContext) => {
  const NOW = 1_790_000_000_000;
  testContext.mock.timers.enable({ apis: ["Date"], now: NOW });
  const windows: [number, number][] = [];
  const row = {
    total: 10,
    text: 6,
    audio: 2,
    image: 1,
    video: 1,
    done: 7,
    failed: 1,
    abandoned: 1,
    inflight: 1,
  };
  const { admin } = setup({
    repo: {
      windowStats: async (from: number, to: number) => {
        windows.push([from, to]);
        return row;
      },
    },
  });

  assert.equal(
    await admin.stats("week"),
    "📊 last 7 days\nJots: 10\n  text 6 · voice 2 · image 1 · video 1\nDone 7 · in-flight 1 · failed 1 · abandoned 1",
  );
  assert.match(await admin.stats("ALL"), /^📊 all time\n/);
  // No argument means today, from local midnight.
  assert.match(await admin.stats(""), /^📊 today\n/);
  assert.deepEqual(windows, [
    [NOW - 7 * 86_400_000, NOW + 1000],
    [0, NOW + 1000],
    [startOfToday(NOW), NOW + 1000],
  ]);

  assert.equal(await admin.stats("month"), "usage: /stats [today|week|all]");
  assert.equal(windows.length, 3, "a bad range never reaches the database");
  assert.equal(await admin.stats("toString"), "usage: /stats [today|week|all]");
});

test("/status joins the snapshot with the upstream health", async (testContext) => {
  const NOW = 1_790_000_000_000;
  testContext.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { admin } = setup({
    startedAt: NOW - 10_500_000,
    build: { version: "1.34.0", sha: "abc1234def" },
    repo: {
      statusCounts: async () => ({
        pending: 1,
        processing: 1,
        done: 5,
        failed: 2,
        abandoned: 1,
        deleted: 4,
      }),
    },
    queue: { depth: 3 },
    transcriber: { chain: "groq → parakeet" },
    links: { stats: () => ({ enabled: true, files: 12, aliases: 40 }) },
    health: {
      snapshot: () => [
        {
          name: "groq",
          up: true,
          latencyMs: 120,
          error: null,
          failures: 0,
          since: NOW,
        },
        {
          name: "parakeet",
          up: false,
          latencyMs: null,
          error: "ECONNREFUSED",
          failures: 2,
          since: NOW - 90_000,
        },
      ],
    },
  });
  assert.equal(
    await admin.status(),
    "🩺 scriba 1.34.0 (abc1234)\nUptime: 2h 55m\nJots: 5 done · 2 in-flight · 2 failed · 1 abandoned\nQueue depth: 3\nTranscriber: groq → parakeet\nLink index: 12 files / 40 aliases\n\nUpstreams:\n🟢 groq · 120 ms\n🔴 parakeet · down 1m 30s · not probed yet · ECONNREFUSED",
  );
});

test("/unreject with a word and a note removes that rejection and says which", async () => {
  // The note is the last token, so a multi-word surface keeps everything before it.
  const seen: string[][] = [];
  const removed = setup({
    repo: {
      unreject: async (surface: string, note: string) => {
        seen.push([surface, note]);
        return 1;
      },
    },
  });
  assert.equal(
    await removed.admin.unreject("new york NYC"),
    '↩️ "new york" may link to [[NYC]] again',
  );
  assert.deepEqual(seen, [["new york", "NYC"]]);
  assert.equal(
    await setup().admin.unreject("monday Monday"),
    'no rejection for "monday" → [[Monday]]',
  );
  assert.equal(
    await setup().admin.unreject("monday"),
    "usage: /unreject <word> <note> (or /unreject with no args for a menu)",
  );
});

test("/unreject with no args offers each rejected word once, capped at 30", async () => {
  assert.equal(await setup().admin.unreject(""), "(no rejections)");

  const list = [
    { surface: "monday", note: "Monday" },
    { surface: "monday", note: "Mondays" },
    { surface: "norway", note: "Norway" },
  ];
  assert.deepEqual(
    await setup({ repo: { rejectionList: async () => list } }).admin.unreject(
      "",
    ),
    { surfaces: ["monday", "norway"], total: 2 },
  );

  const many = Array.from({ length: 35 }, (_, index) => ({
    surface: `word${index}`,
    note: "N",
  }));
  const picker = await setup({
    repo: { rejectionList: async () => many },
  }).admin.unreject("");
  assert.equal(typeof picker === "object" && picker.surfaces.length, 30);
  assert.equal(typeof picker === "object" && picker.total, 35);
});

test("/flush drains the queue and reports how many were waiting", async () => {
  const flushed: string[] = [];
  const { admin } = setup({
    queue: { depth: 3, flush: async () => void flushed.push("flush") },
  });
  assert.equal(await admin.flush(), "⚡ flushed (3 queued)");
  assert.deepEqual(flushed, ["flush"]);
});

test("/sweep runs the retry pass and confirms", async () => {
  const { admin, calls } = setup();
  assert.equal(await admin.retryPass(), "🧹 sweep done");
  assert.deepEqual(calls, ["retryPass()"]);
});

test("/version names the running release and the first seven characters of the sha", () => {
  const { admin } = setup({
    build: { version: "1.34.0", sha: "abcdef0123456" },
  });
  assert.equal(admin.version(), "scriba 1.34.0 (abcdef0)");
});

async function summaryFor(stats: Record<string, number>) {
  const sent: string[] = [];
  const admin = new AdminController({
    repo: { windowStats: async () => stats },
    notifier: { notify: async (text: string) => void sent.push(text) },
  } as never);
  await admin.dailySummary();
  return sent;
}
const NO_JOTS = { total: 0, audio: 0, failed: 0, abandoned: 0 };

test("the daily summary stays quiet on a day with no jots", async () => {
  assert.deepEqual(await summaryFor(NO_JOTS), []);
});

test("the daily summary counts jots, and names failures only when there are some", async () => {
  const clean = await summaryFor({ ...NO_JOTS, total: 4, audio: 1 });
  assert.equal(clean.length, 1);
  assert.match(clean[0]!, /Jots: 4 \(voice: 1\)/);
  assert.ok(!clean[0]!.includes("Failed"));

  // failed and abandoned are one number to the reader: both mean "didn't finish cleanly".
  const bad = await summaryFor({
    ...NO_JOTS,
    total: 4,
    audio: 1,
    failed: 1,
    abandoned: 2,
  });
  assert.match(bad[0]!, /⚠️ Failed\/abandoned: 3/);
});

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
  const items = Array.from({ length: 5 }, (_, i) => `item${i + 1}`);
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

const target = (id: string, anchor = id) =>
  aJot({ id, anchor, status: "done" });

test("reprocessCount counts a squashed follower with its leader and reads the whole days", async () => {
  const windows: number[][] = [];
  const { admin } = setup({
    repo: {
      jotsInRange: async (from: number, to: number) => {
        windows.push([from, to]);
        return [target("a1"), target("a2", "a1"), target("b1")];
      },
    },
  });
  assert.equal(await admin.reprocessCount("2026-10-05", "2026-10-09"), 2);
  assert.deepEqual(windows, [
    [dayBounds("2026-10-05")[0], dayBounds("2026-10-09")[1]],
  ]);
});

test("jotsPage asks for one row past the page to know whether Next exists", async () => {
  const asked: number[][] = [];
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => target(`j${index}`));
  const { admin } = setup({
    repo: {
      jotsPage: async (offset: number, limit: number) => {
        asked.push([offset, limit]);
        return rows(offset === 0 ? 9 : 3);
      },
    },
  });
  const first = await admin.jotsPage(0);
  assert.equal(first.items.length, 8);
  assert.deepEqual([first.page, first.pages, first.offset], [0, 2, 0]);
  const last = await admin.jotsPage(1);
  assert.equal(last.items.length, 3);
  assert.deepEqual([last.page, last.pages, last.offset], [1, 2, 8]);
  assert.deepEqual(asked, [
    [0, 9],
    [8, 9],
  ]);
});

test("reprocessPick refuses a jot that is gone or still in flight and accepts a finished one", async () => {
  const withStatus = (status: string) =>
    setup({ repo: { getJot: async () => aJot({ status: status as never }) } })
      .admin;
  assert.equal(await setup().admin.reprocessPick("nope"), "gone");
  const noId = setup();
  assert.equal(await noId.admin.reprocessPick(undefined), "gone");
  assert.deepEqual(noId.calls, []);
  for (const status of ["pending", "processing", "deleted"])
    assert.equal(await withStatus(status).reprocessPick("abcd1234"), "busy");
  for (const status of ["done", "failed", "abandoned"]) {
    const picked = await withStatus(status).reprocessPick("abcd1234");
    assert.equal(typeof picked === "string" ? picked : picked.status, status);
  }
});

test("reprocessExecute on a day resets the distinct leaders and queues only what was reset", async () => {
  const { admin, calls } = setup({
    repo: {
      jotsInRange: async () => [
        target("a1"),
        target("a2", "a1"),
        target("b1"),
        target("c1"),
      ],
      resetForReprocess: async (ids: string[]) => {
        calls.push(`reset(${ids.join(",")})`);
        return ["a1", "c1"];
      },
    },
  });
  const out = await admin.reprocessExecute({
    lo: "2026-10-05",
    hi: "2026-10-05",
    day: true,
  });
  assert.deepEqual(out, {
    text: "🔁 Reprocessing 2 jots from 2026-10-05…",
    queued: true,
  });
  assert.deepEqual(calls, ["reset(a1,b1,c1)", "queue.add(a1,c1)"]);
});

test("reprocessExecute on a range labels it with an arrow", async () => {
  const { admin } = setup({
    repo: {
      jotsInRange: async () => [target("a1")],
      resetForReprocess: async () => ["a1"],
    },
  });
  const out = await admin.reprocessExecute({
    lo: "2026-10-05",
    hi: "2026-10-09",
    day: false,
  });
  assert.equal(out.text, "🔁 Reprocessing 1 jot from 2026-10-05 → 2026-10-09…");
});

test("reprocessExecute on a squashed follower reprocesses its leader", async () => {
  const { admin, calls } = setup({
    repo: {
      getJot: async () => target("f1", "lead"),
      resetForReprocess: async (ids: string[]) => {
        calls.push(`reset(${ids.join(",")})`);
        return ids;
      },
    },
  });
  const out = await admin.reprocessExecute({ jot: "f1" });
  assert.equal(out.text, "🔁 Reprocessing 1 jot from lead…");
  assert.deepEqual(calls, ["reset(lead)", "queue.add(lead)"]);
});

test("reprocessExecute reports a vanished jot, an empty day and a lost race without queueing", async () => {
  const gone = setup();
  assert.deepEqual(await gone.admin.reprocessExecute({ jot: "gone1" }), {
    text: "Jot gone1 not found.",
    queued: false,
  });

  const empty = setup({ repo: { jotsInRange: async () => [] } });
  assert.deepEqual(
    await empty.admin.reprocessExecute({
      lo: "2026-10-05",
      hi: "2026-10-05",
      day: true,
    }),
    { text: "No reprocessable jots for 2026-10-05.", queued: false },
  );

  const raced = setup({
    repo: {
      jotsInRange: async () => [target("a1")],
      resetForReprocess: async () => [],
    },
  });
  assert.deepEqual(
    await raced.admin.reprocessExecute({
      lo: "2026-10-05",
      hi: "2026-10-05",
      day: true,
    }),
    { text: "No reprocessable jots for 2026-10-05 anymore.", queued: false },
  );
  for (const run of [gone, empty, raced])
    assert.ok(!run.calls.some((call) => call.startsWith("queue.add")));
});
