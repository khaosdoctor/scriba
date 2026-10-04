import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../domain/jot/entity.ts";
import type { ReleaseNote } from "../domain/release/structures.ts";
import { startOfToday } from "../libs/time.ts";
import { sampleJot } from "../test/sqlite.ts";
import { AdminService } from "./admin.ts";

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
  const repo = {
    getJot: track("getJot", null),
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
    repo,
    linkRules: repo,
    settings: repo,
    queue: {
      add: (ids: string[]) => void calls.push(`queue.add(${ids.join(",")})`),
      ...over.queue,
    },
    processing: { retryPass: track("retryPass"), ...over.processing },
    transcriber: { chain: "groq → parakeet", ...over.transcriber },
    jots: {
      retry: async (jot: Jot) => {
        calls.push(`jots.retry(${jot.id})`);
        return "queued";
      },
      ...over.jots,
    },
  };
  return { admin: new AdminService(deps as never), calls };
}

test("/retry with an id takes the button's retry, so a squashed follower retries its leader's line", async () => {
  const follower = aJot({ id: "f0110000", anchor: "abcd1234" });
  const { admin, calls } = setup({ repo: { getJot: async () => follower } });
  assert.equal(await admin.retry("f0110000"), "🔄 retrying f0110000");
  assert.deepEqual(
    calls.filter((call) => !call.startsWith("getJot")),
    ["jots.retry(f0110000)"],
  );
});

test("/retry with an id retries that jot alone", async () => {
  const { admin, calls } = setup({ repo: { getJot: async () => aJot() } });
  assert.equal(await admin.retry(" ABCD1234 "), "🔄 retrying abcd1234");
  assert.ok(calls.includes("jots.retry(abcd1234)"));
  // One jot, so the pass isn't kicked for the whole backlog.
  assert.ok(!calls.some((call) => call.startsWith("retryPass")));
});

test("/retry with an unknown id says so instead of queueing nothing", async () => {
  const { admin, calls } = setup();
  assert.equal(await admin.retry("nope"), "no jot nope");
  assert.ok(!calls.some((call) => call.startsWith("jots.retry")));
});

test("/retry with an id refuses a jot being processed, and a deleted id is no jot", async () => {
  const busy = setup({
    repo: { getJot: async () => aJot() },
    jots: { retry: async () => "in-flight" },
  });
  assert.equal(
    await busy.admin.retry("abcd1234"),
    "⏳ abcd1234 is still processing",
  );

  const gone = setup({
    repo: { getJot: async () => aJot({ status: "deleted" }) },
  });
  assert.equal(await gone.admin.retry("abcd1234"), "no jot abcd1234");
  assert.ok(!gone.calls.some((call) => call.startsWith("jots.retry")));
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

// A batch can wait minutes on a voice-fix tap, and that tap is an update grammy only
// handles once this command's handler returns: the reply must not wait for the batch.
const neverSettles = () => new Promise<void>(() => {});

test("/flush starts the drain without waiting for the batch", async () => {
  const flushed: string[] = [];
  const { admin } = setup({
    queue: {
      depth: 3,
      flush: () => {
        flushed.push("flush");
        return neverSettles();
      },
    },
  });
  assert.equal(await admin.flush(), "⚡ flushing (3 queued)");
  assert.deepEqual(flushed, ["flush"]);
});

test("/sweep starts the retry pass without waiting for it", async () => {
  const passes: string[] = [];
  const { admin } = setup({
    processing: {
      retryPass: () => {
        passes.push("retryPass");
        return neverSettles();
      },
    },
  });
  assert.equal(await admin.retryPass(), "🧹 sweep started");
  assert.deepEqual(passes, ["retryPass"]);
});

test("a sweep that fails in the background is logged, not left unhandled", async () => {
  const { admin } = setup({
    processing: {
      retryPass: () => Promise.reject(new Error("database is locked")),
    },
  });
  assert.equal(await admin.retryPass(), "🧹 sweep started");
  // node:test fails the run on an unhandled rejection, reported once this tick ends.
  await new Promise((resolve) => setImmediate(resolve));
});

test("/version names the running release and the first seven characters of the sha", () => {
  const { admin } = setup({
    build: { version: "1.34.0", sha: "abcdef0123456" },
  });
  assert.equal(admin.version(), "scriba 1.34.0 (abcdef0)");
});

async function summaryFor(stats: Record<string, number>) {
  const sent: string[] = [];
  const admin = new AdminService({
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

const target = (id: string, anchor = id) =>
  aJot({ id, anchor, status: "done" });

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
