import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../db.ts";
import type { ReleaseNote } from "../services/github.ts";
import { startOfToday } from "../time.ts";
import { commands } from "./index.ts";
import type { Command, Deps } from "./types.ts";

/**
 * The admin commands are one file each but one surface: every entry in the registry is
 * looped over in `bot.ts` and handed the same `(ctx, args, deps)`. They're tested together
 * here for the same reason — what matters is the registry being well-formed and each
 * command's argument branching, not the files they happen to live in.
 */

const byName = (name: string): Command => {
  const cmd = commands.find((c) => c.name === name);
  assert.ok(cmd, `no /${name} in the registry`);
  return cmd;
};

const aJot = (over: Partial<Jot> = {}): Jot =>
  ({
    id: "abcd1234",
    anchor: "abcd1234",
    kind: "text",
    status: "failed",
    attempts: 2,
    raw_text: "a thought",
    transcript: null,
    asset_path: null,
    note_path: "notes/daily notes/2026-08-16.md",
    time: "10:00:00",
    received_at: 0,
    error: "fetch failed",
    ...over,
  }) as Jot;

/** Deps with every collaborator recorded. Anything a test doesn't override throws if
 *  touched, so a command reaching for something it shouldn't shows up as a failure. */
function deps(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const track =
    (name: string, out?: any) =>
    async (...args: any[]) => {
      calls.push(`${name}(${args.join(",")})`);
      return typeof out === "function" ? out(...args) : out;
    };
  const d = {
    links: {},
    github: {},
    version: "1.34.0",
    sha: "abc1234",
    startedAt: Date.now(),
    ...over,
    calls,
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
    processor: { retrySweep: track("retrySweep"), ...over.processor },
    transcriber: { chain: "groq → parakeet", ...over.transcriber },
  };
  return d as unknown as Deps & { calls: string[] };
}

/** A ctx that records replies, for the commands that answer with a keyboard themselves. */
function ctx() {
  const replies: { text: string; opts: any }[] = [];
  return {
    replies,
    ctx: {
      reply: async (text: string, opts: any = {}) => {
        replies.push({ text, opts });
      },
    } as any,
  };
}

test("the registry is well-formed and safe to hand to Telegram", () => {
  assert.ok(commands.length > 5);
  const names = commands.map((c) => c.name);
  assert.deepEqual(
    names.filter((n, i) => names.indexOf(n) !== i),
    [],
    "duplicate command names would register two handlers for one command",
  );
  for (const c of commands) {
    // setMyCommands rejects anything outside this shape, and bot.ts only warns on that
    // failure — one bad name silently costs the whole `/` menu.
    assert.match(c.name, /^[a-z0-9_]{1,32}$/, `bad command name: ${c.name}`);
    assert.ok(c.description.trim(), `/${c.name} has no description`);
    assert.ok(
      c.description.length <= 256,
      `/${c.name}'s description is too long`,
    );
    assert.equal(typeof c.run, "function");
  }
});

test("/help lists the whole registry, itself included", async () => {
  const out = await byName("help").run({} as any, "", deps());
  assert.ok(typeof out === "string");
  for (const c of commands)
    assert.ok(out.includes(`/${c.name} —`), `/help omits /${c.name}`);
  assert.ok(out.includes("/help —"));
});

test("/retry with an id resets and queues that jot alone", async () => {
  const d = deps({ repo: { getJot: async () => aJot() } });
  assert.equal(
    await byName("retry").run({} as any, " ABCD1234 ", d),
    "🔄 retrying abcd1234",
  );
  assert.ok(d.calls.includes("resetForRetry(abcd1234)"));
  assert.ok(d.calls.includes("queue.add(abcd1234)"));
  // One jot, so the sweep isn't kicked for the whole backlog.
  assert.ok(!d.calls.some((c) => c.startsWith("retrySweep")));
});

test("/retry with an unknown id says so instead of queueing nothing", async () => {
  const d = deps();
  assert.equal(await byName("retry").run({} as any, "nope", d), "no jot nope");
  assert.ok(!d.calls.some((c) => c.startsWith("resetForRetry")));
});

test("/retry with no args takes the failed ones; `all` includes the abandoned", async () => {
  // An override replaces the tracked stub, so it records its own argument: whether the
  // abandoned jots are swept back in is the whole difference between these two calls.
  const scope: boolean[] = [];
  const resetFailed = (n: number) => async (all: boolean) => {
    scope.push(all);
    return n;
  };

  const d = deps({ repo: { resetFailed: resetFailed(3) } });
  assert.equal(
    await byName("retry").run({} as any, "", d),
    "🔄 requeued 3 jots",
  );
  assert.ok(d.calls.some((c) => c.startsWith("retrySweep")));

  const all = deps({ repo: { resetFailed: resetFailed(1) } });
  assert.equal(
    await byName("retry").run({} as any, "ALL", all),
    "🔄 requeued 1 jot (incl. abandoned)",
  );
  assert.deepEqual(scope, [false, true]);
});

test("/retry doesn't run a sweep when nothing was requeued", async () => {
  const d = deps({ repo: { resetFailed: async () => 0 } });
  await byName("retry").run({} as any, "", d);
  assert.ok(!d.calls.some((c) => c.startsWith("retrySweep")));
});

test("/stopword add and del need a word, and say what changed", async () => {
  const add = deps();
  assert.equal(
    await byName("stopword").run({} as any, "add Monday", add),
    '➕ stopword "monday"',
  );
  assert.ok(add.calls.includes("addStopword(Monday)"));
  assert.equal(
    await byName("stopword").run({} as any, "add", deps()),
    "usage: /stopword add <word>",
  );

  const hit = deps({ repo: { delStopword: async () => 1 } });
  assert.equal(
    await byName("stopword").run({} as any, "del Monday", hit),
    '➖ removed "monday"',
  );
  // Nothing removed is not the same as removed — the reply has to tell them apart.
  assert.equal(
    await byName("stopword").run({} as any, "del Monday", deps()),
    'no stopword "monday"',
  );
});

test("/stopword list paginates, and a bad subcommand gets usage", async () => {
  const words = new Set(Array.from({ length: 130 }, (_, i) => `w${i + 1000}`));
  const d = deps({ repo: { stopwords: async () => words } });
  const page1 = (await byName("stopword").run({} as any, "list", d)) as string;
  assert.match(page1, /page 1\/3/);
  assert.match(page1, /next: \/stopword list 2/);
  const page2 = (await byName("stopword").run(
    {} as any,
    "list 2",
    d,
  )) as string;
  assert.match(page2, /page 2\/3/);
  // Out-of-range and junk page numbers clamp rather than answering with a blank page.
  assert.match(
    (await byName("stopword").run({} as any, "list 99", d)) as string,
    /page 3\/3/,
  );
  assert.match(
    (await byName("stopword").run({} as any, "list zz", d)) as string,
    /page 1\/3/,
  );
  assert.equal(
    await byName("stopword").run({} as any, "", deps()),
    "usage: /stopword add|del|list [word]",
  );
  assert.equal(
    await byName("stopword").run({} as any, "list", deps()),
    "(none)",
  );
});

test("/jot needs an id and reports one that isn't there", async () => {
  assert.equal(
    await byName("jot").run({} as any, "  ", deps()),
    "usage: /jot <id>",
  );
  assert.equal(
    await byName("jot").run({} as any, "abcd1234", deps()),
    "no jot abcd1234",
  );
  const found = (await byName("jot").run(
    {} as any,
    "abcd1234",
    deps({ repo: { getJot: async () => aJot() } }),
  )) as string;
  assert.match(found, /abcd1234/);
});

test("/failed lists nothing cheerfully, and otherwise gives a button per jot", async () => {
  const empty = ctx();
  assert.equal(
    await byName("failed").run(empty.ctx, "", deps()),
    "✅ nothing failed.",
  );
  assert.equal(empty.replies.length, 0);

  const jots = [aJot(), aJot({ id: "ffff0001", status: "abandoned" })];
  const some = ctx();
  await byName("failed").run(
    some.ctx,
    "",
    deps({ repo: { failedJots: async () => jots } }),
  );
  const [reply] = some.replies;
  assert.match(reply!.text, /2 failed/);
  assert.match(reply!.text, /abcd1234 \[text\] failed ×2 — fetch failed/);
  // grammy leaves a trailing empty row after the last .row(); count the filled ones.
  const rows = reply!.opts.reply_markup.inline_keyboard.filter(
    (r: any[]) => r.length,
  );
  assert.equal(rows.length, 2, "one row per jot");
  // The same 🔄 Retry / 🗑 Delete pair the failure messages carry, per row.
  assert.deepEqual(
    rows.map((r: any[]) => r.map((b: any) => b.callback_data)),
    [
      ["rt:abcd1234", "dl:abcd1234"],
      ["rt:ffff0001", "dl:ffff0001"],
    ],
  );
});

test("/rejections and /unstick report their counts", async () => {
  assert.equal(
    await byName("rejections").run({} as any, "", deps()),
    "(no rejections)",
  );
  const listed = (await byName("rejections").run(
    {} as any,
    "",
    deps({
      repo: {
        rejectionList: async () => [{ surface: "monday", note: "Monday" }],
      },
    }),
  )) as string;
  assert.equal(listed, '"monday" ✗ [[Monday]]');

  assert.equal(
    await byName("unstick").run({} as any, "", deps()),
    "🔧 unstuck 0 jots",
  );
  assert.equal(
    await byName("unstick").run(
      {} as any,
      "",
      deps({ repo: { resetProcessing: async () => 1 } }),
    ),
    "🔧 unstuck 1 jot",
  );
});

const DASH = String.fromCharCode(0x2014);

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
  const d = deps({ github: { latest: async () => release() } });
  assert.equal(
    await byName("changelog").run({} as any, "", d),
    "📋 v1.34.0\n\nFeatures:\n• offer to move TIL jots\n\nBug Fixes:\n• keep the card\n\nhttps://github.com/o/r/releases/tag/v1.34.0",
  );
});

test("/changelog says so when GitHub can't be reached", async () => {
  const down = { latest: async () => null, byVersion: async () => null };
  assert.equal(
    await byName("changelog").run({} as any, "", deps({ github: down })),
    "⚠️ couldn't reach GitHub for the latest release",
  );
  assert.equal(
    await byName("changelog").run({} as any, "9.9.9", deps({ github: down })),
    "no release found for 9.9.9",
  );
  assert.equal(
    await byName("changelog").run(
      {} as any,
      "5",
      deps({ github: { recent: async () => [] } }),
    ),
    "⚠️ couldn't reach GitHub for release history",
  );
});

test("/changelog with a version looks that version up", async () => {
  const asked: string[] = [];
  const d = deps({
    github: {
      byVersion: async (v: string) => {
        asked.push(v);
        return release({ name: "v1.2.3", body: "", url: "https://x/1.2.3" });
      },
    },
  });
  assert.equal(
    await byName("changelog").run({} as any, " 1.2.3 ", d),
    "📋 v1.2.3\n\nhttps://x/1.2.3",
  );
  assert.deepEqual(asked, ["1.2.3"]);
});

test("/changelog N lists the N most recent releases and clamps N to 1-20", async () => {
  const asked: number[] = [];
  const d = deps({
    github: {
      recent: async (n: number) => {
        asked.push(n);
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
    await byName("changelog").run({} as any, "2", d),
    `• v1.34.0 (2026-09-30) ${DASH} https://github.com/o/r/releases/tag/v1.34.0\n• v1.33.0 (2026-09-22) ${DASH} https://github.com/o/r/releases/tag/v1.33.0`,
  );
  await byName("changelog").run({} as any, "0", d);
  await byName("changelog").run({} as any, "99", d);
  assert.deepEqual(asked, [2, 1, 20]);
});

test("/stats asks for the window it names and refuses anything else", async (t) => {
  const NOW = 1_790_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
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
  const d = deps({
    repo: {
      windowStats: async (from: number, to: number) => {
        windows.push([from, to]);
        return row;
      },
    },
  });

  assert.equal(
    await byName("stats").run({} as any, "week", d),
    "📊 last 7 days\nJots: 10\n  text 6 · voice 2 · image 1 · video 1\nDone 7 · in-flight 1 · failed 1 · abandoned 1",
  );
  assert.match(
    (await byName("stats").run({} as any, "ALL", d)) as string,
    /^📊 all time\n/,
  );
  // No argument means today, from local midnight.
  assert.match(
    (await byName("stats").run({} as any, "", d)) as string,
    /^📊 today\n/,
  );
  assert.deepEqual(windows, [
    [NOW - 7 * 86_400_000, NOW + 1000],
    [0, NOW + 1000],
    [startOfToday(NOW), NOW + 1000],
  ]);

  assert.equal(
    await byName("stats").run({} as any, "month", d),
    "usage: /stats [today|week|all]",
  );
  assert.equal(windows.length, 3, "a bad range never reaches the database");
});

test("/status joins the snapshot with the upstream health", async (t) => {
  const NOW = 1_790_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const d = deps({
    startedAt: NOW - 10_500_000,
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
    sha: "abc1234def",
  });
  assert.equal(
    await byName("status").run({} as any, "", d),
    "🩺 scriba 1.34.0 (abc1234)\nUptime: 2h 55m\nJots: 5 done · 2 in-flight · 2 failed · 1 abandoned\nQueue depth: 3\nTranscriber: groq → parakeet\nLink index: 12 files / 40 aliases\n\nUpstreams:\n🟢 groq · 120 ms\n🔴 parakeet · down 1m 30s · not probed yet · ECONNREFUSED",
  );
});

test("/unreject with a word and a note removes that rejection and says which", async () => {
  // The note is the last token, so a multi-word surface keeps everything before it.
  const seen: string[][] = [];
  const removed = deps({
    repo: {
      unreject: async (surface: string, note: string) => {
        seen.push([surface, note]);
        return 1;
      },
    },
  });
  assert.equal(
    await byName("unreject").run({} as any, "new york NYC", removed),
    '↩️ "new york" may link to [[NYC]] again',
  );
  assert.deepEqual(seen, [["new york", "NYC"]]);
  assert.equal(
    await byName("unreject").run({} as any, "monday Monday", deps()),
    'no rejection for "monday" → [[Monday]]',
  );
  assert.equal(
    await byName("unreject").run({} as any, "monday", deps()),
    "usage: /unreject <word> <note> (or /unreject with no args for a menu)",
  );
});

test("/unreject with no args offers one button per rejected word", async () => {
  const none = ctx();
  assert.equal(
    await byName("unreject").run(none.ctx, "", deps()),
    "(no rejections)",
  );
  assert.equal(none.replies.length, 0);

  const list = [
    { surface: "monday", note: "Monday" },
    { surface: "monday", note: "Mondays" },
    { surface: "norway", note: "Norway" },
  ];
  const some = ctx();
  await byName("unreject").run(
    some.ctx,
    "",
    deps({ repo: { rejectionList: async () => list } }),
  );
  const [reply] = some.replies;
  assert.equal(reply!.text, "Pick a rejected word to unreject:");
  const rows = reply!.opts.reply_markup.inline_keyboard.filter(
    (r: any[]) => r.length,
  );
  // One button per distinct word, however many notes it was rejected for.
  assert.deepEqual(
    rows.map((r: any[]) => [r[0].text, r[0].callback_data]),
    [
      ["monday", "ur:s:0"],
      ["norway", "ur:s:1"],
    ],
  );
});

test("/unreject caps the keyboard at 30 words and names the cut", async () => {
  const list = Array.from({ length: 35 }, (_, i) => ({
    surface: `word${i}`,
    note: "N",
  }));
  const some = ctx();
  await byName("unreject").run(
    some.ctx,
    "",
    deps({ repo: { rejectionList: async () => list } }),
  );
  const [reply] = some.replies;
  assert.equal(
    reply!.text,
    `Pick a rejected word to unreject (30 of 35 ${DASH} /menu › 🔗 Link rules pages through the rest):`,
  );
  const rows = reply!.opts.reply_markup.inline_keyboard.filter(
    (r: any[]) => r.length,
  );
  assert.equal(rows.length, 30);
});

test("/flush drains the queue and reports how many were waiting", async () => {
  const flushed: string[] = [];
  const d = deps({
    queue: { depth: 3, flush: async () => void flushed.push("flush") },
  });
  assert.equal(
    await byName("flush").run({} as any, "", d),
    "⚡ flushed (3 queued)",
  );
  assert.deepEqual(flushed, ["flush"]);
});

test("/sweep runs the retry sweep and confirms", async () => {
  const d = deps();
  assert.equal(await byName("sweep").run({} as any, "", d), "🧹 sweep done");
  assert.deepEqual(d.calls, ["retrySweep()"]);
});

test("/version names the running release and the first seven characters of the sha", async () => {
  assert.equal(
    await byName("version").run({} as any, "", deps({ sha: "abcdef0123456" })),
    "scriba 1.34.0 (abcdef0)",
  );
});
