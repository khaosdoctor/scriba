import assert from "node:assert/strict";
import { test } from "node:test";

// reprocess.ts pulls in config.ts, which validates process.env at import time.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { ReprocessCommand } = await import("./reprocess.ts");
const { config } = await import("../config.ts");
const { dayBounds } = await import("../time.ts");

type Button = { text: string; callback_data: string };

const ROOT_TEXT = "🔁 Reprocess \u{2014} choose scope:";
const CLOSE_ROW = [["✖ Close", "rp:close"]];

function pairs(kb: { inline_keyboard: Button[][] }): string[][][] {
  return kb.inline_keyboard.map((row) =>
    row.map((b) => [b.text, b.callback_data]),
  );
}

function jot(over: Record<string, unknown> = {}) {
  return {
    id: "aaaa1111",
    anchor: "aaaa1111",
    kind: "text",
    status: "done",
    time: "10:15",
    raw_text: "hello world",
    transcript: null,
    received_at: new Date(2026, 9, 5, 10, 15).getTime(),
    ...over,
  };
}

/** Every call the flow makes, in order, in one list: that is how "ack before the I/O"
 *  is asserted. */
function setup(
  repoOver: Record<string, unknown> = {},
  opts: { queue?: boolean; deleteFails?: boolean; editFails?: boolean } = {},
) {
  const events: string[] = [];
  const edits: { text: string; kb: { inline_keyboard: Button[][] } }[] = [];
  const sent: { chat: number; text: string; kb: any }[] = [];
  const queued: string[][] = [];
  const resets: string[][] = [];
  const ranges: [number, number][] = [];
  const pages: [number, number][] = [];
  const repo = {
    jotsInRange: async (from: number, to: number) => {
      events.push("jotsInRange");
      ranges.push([from, to]);
      return [];
    },
    jotsPage: async (offset: number, limit: number) => {
      events.push("jotsPage");
      pages.push([offset, limit]);
      return [];
    },
    getJot: async () => {
      events.push("getJot");
      return undefined;
    },
    resetForReprocess: async (ids: string[]) => {
      events.push("resetForReprocess");
      resets.push(ids);
      return ids;
    },
    ...repoOver,
  };
  const bot = {
    api: {
      sendMessage: async (chat: number, text: string, o: any) => {
        sent.push({ chat, text, kb: o.reply_markup });
      },
    },
  };
  const reprocess = new ReprocessCommand(bot as any, repo as any);
  if (opts.queue !== false) {
    reprocess.setQueue({
      add: (ids: string[]) => {
        events.push("queue.add");
        queued.push(ids);
      },
    } as any);
  }
  const ctx = {
    answerCallbackQuery: async (a?: { text: string }) => {
      events.push(a?.text ? `ack:${a.text}` : "ack");
    },
    editMessageText: async (text: string, o?: any) => {
      if (opts.editFails) throw new Error("message can't be edited");
      events.push("edit");
      edits.push({ text, kb: o?.reply_markup });
    },
    deleteMessage: async () => {
      if (opts.deleteFails) throw new Error("message can't be deleted");
      events.push("delete");
    },
    reply: async (text: string, o: any) => {
      sent.push({ chat: -1, text, kb: o.reply_markup });
    },
  };
  const tap = (...rest: string[]) => (reprocess as any).handleTap(ctx, rest);
  return {
    reprocess,
    ctx,
    tap,
    events,
    edits,
    sent,
    queued,
    resets,
    ranges,
    pages,
  };
}

// --- entry points ---

test("/reprocess opens the scope picker with a Close button", async () => {
  const h = setup();
  await h.reprocess.slashReprocess(h.ctx as any);
  assert.equal(h.sent[0]!.text, ROOT_TEXT);
  assert.deepEqual(pairs(h.sent[0]!.kb), [
    [["📅 One day", "rp:day"]],
    [["📆 Date range", "rp:range"]],
    [["✉️ One jot", "rp:jot:0"]],
    ...[CLOSE_ROW],
  ]);
});

test("/menu's Reprocess entry posts a fresh picker to the owner", async () => {
  const h = setup();
  await h.reprocess.promptRoot();
  assert.equal(h.sent[0]!.chat, config.telegram.allowedUserId);
  assert.equal(h.sent[0]!.text, ROOT_TEXT);
  assert.equal(h.sent[0]!.kb.inline_keyboard.length, 4);
});

test("the root tap goes back to the scope picker, noop answers and nothing else", async () => {
  const h = setup();
  await h.tap("root");
  assert.deepEqual(h.events, ["ack", "edit"]);
  assert.equal(h.edits[0]!.text, ROOT_TEXT);
  assert.equal(h.edits[0]!.kb.inline_keyboard[0]![0]!.callback_data, "rp:day");

  const n = setup();
  await n.tap("noop");
  assert.deepEqual(n.events, ["ack"]);
});

test("an unknown action is answered empty and ignored", async () => {
  const h = setup();
  await h.tap("frobnicate");
  assert.deepEqual(h.events, ["ack"]);
});

// --- calendars ---

test("the day calendar lays out October 2026 Sunday-first with month nav", async () => {
  const h = setup();
  await h.tap("day", "2026", "10");
  assert.deepEqual(h.events, ["ack", "edit"]);
  assert.equal(h.edits[0]!.text, "📅 Pick a day to reprocess (Oct 2026):");
  const rows = pairs(h.edits[0]!.kb);
  assert.deepEqual(
    rows[0]!.map((b) => b[0]),
    ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
  );
  // Oct 1 2026 is a Thursday: four blank cells, then 1..3.
  assert.deepEqual(
    rows[1]!.map((b) => b[0]),
    [" ", " ", " ", " ", "1", "2", "3"],
  );
  assert.deepEqual(rows[1]![4], ["1", "rp:day:2026:10:1"]);
  assert.deepEqual(rows[1]![0], [" ", "rp:noop"]);
  assert.deepEqual(
    rows[5]!.map((b) => b[0]),
    ["25", "26", "27", "28", "29", "30", "31"],
  );
  assert.deepEqual(rows.slice(6), [
    [
      ["‹", "rp:day:2026:9"],
      ["›", "rp:day:2026:11"],
    ],
    [["‹ Back", "rp:root"]],
    CLOSE_ROW,
  ]);
});

test("calendar month nav wraps across the year boundary", async () => {
  const jan = setup();
  await jan.tap("day", "2026", "1");
  const janNav = pairs(jan.edits[0]!.kb).at(-3)!;
  assert.deepEqual(janNav, [
    ["‹", "rp:day:2025:12"],
    ["›", "rp:day:2026:2"],
  ]);

  const dec = setup();
  await dec.tap("day", "2026", "12");
  const decNav = pairs(dec.edits[0]!.kb).at(-3)!;
  assert.deepEqual(decNav, [
    ["‹", "rp:day:2026:11"],
    ["›", "rp:day:2027:1"],
  ]);
});

test("a crafted month or year falls back to the current month", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 4, 20).getTime(),
  });
  const h = setup();
  await h.tap("day", "abc", "13");
  assert.equal(h.edits[0]!.text, "📅 Pick a day to reprocess (May 2026):");
  const years = setup();
  await years.tap("day", "42", "3");
  assert.equal(years.edits[0]!.text, "📅 Pick a day to reprocess (Mar 2026):");
  const bare = setup();
  await bare.tap("day");
  assert.equal(bare.edits[0]!.text, "📅 Pick a day to reprocess (May 2026):");
});

test("the range start calendar carries the range namespace in every callback", async () => {
  const h = setup();
  await h.tap("range", "2026", "10");
  assert.deepEqual(h.events, ["ack", "edit"]);
  assert.equal(h.edits[0]!.text, "📆 Pick the range start (Oct 2026):");
  const rows = pairs(h.edits[0]!.kb);
  assert.deepEqual(rows[1]![4], ["1", "rp:range:2026:10:1"]);
  assert.deepEqual(rows.at(-3), [
    ["‹", "rp:range:2026:9"],
    ["›", "rp:range:2026:11"],
  ]);
});

test("picking the range start opens the end calendar and keeps the start in every callback", async () => {
  const h = setup();
  await h.tap("range", "2026", "10", "5");
  assert.equal(
    h.edits[0]!.text,
    "📆 Start: 2026-10-05. Now pick the range end (Oct 2026):",
  );
  const rows = pairs(h.edits[0]!.kb);
  assert.deepEqual(rows[1]![4], ["1", "rp:rangeend:2026-10-05:2026:10:1"]);
  assert.deepEqual(rows.at(-3), [
    ["‹", "rp:rangeend:2026-10-05:2026:9"],
    ["›", "rp:rangeend:2026-10-05:2026:11"],
  ]);
});

test("paging the end calendar keeps the start", async () => {
  const h = setup();
  await h.tap("rangeend", "2026-10-05", "2026", "11");
  assert.equal(
    h.edits[0]!.text,
    "📆 Start: 2026-10-05. Pick the range end (Nov 2026):",
  );
  assert.deepEqual(pairs(h.edits[0]!.kb)[0]!.length, 7);
});

test("the calendar title names every month with its three-letter English label", async () => {
  const labels: string[] = [];
  for (let month = 1; month <= 12; month++) {
    const h = setup();
    await h.tap("day", "2026", String(month));
    labels.push(h.edits[0]!.text);
  }
  assert.deepEqual(
    labels.map((t) => t.slice(t.indexOf("(") + 1, -2)),
    [
      "Jan 2026",
      "Feb 2026",
      "Mar 2026",
      "Apr 2026",
      "May 2026",
      "Jun 2026",
      "Jul 2026",
      "Aug 2026",
      "Sep 2026",
      "Oct 2026",
      "Nov 2026",
      "Dec 2026",
    ],
  );
});

// --- one day ---

test("tapping a day asks to confirm with the count of distinct targets", async () => {
  const rows = [
    jot({ id: "a1", anchor: "a1" }),
    jot({ id: "a2", anchor: "a1" }),
    jot({ id: "b1", anchor: "b1" }),
  ];
  const h = setup({
    jotsInRange: async (from: number, to: number) => {
      h.ranges.push([from, to]);
      return rows;
    },
  });
  await h.tap("day", "2026", "10", "5");
  assert.deepEqual(h.ranges, [dayBounds("2026-10-05")]);
  assert.equal(h.edits[0]!.text, "Reprocess 2 jots from 2026-10-05?");
  assert.deepEqual(pairs(h.edits[0]!.kb), [
    [["🔁 Yes, reprocess 2 jots", "rp:go:d:2026-10-05"]],
    [["Cancel", "rp:cancel"]],
    CLOSE_ROW,
  ]);
});

test("a day with a single target says 'jot', not 'jots'", async () => {
  const h = setup({ jotsInRange: async () => [jot()] });
  await h.tap("day", "2026", "10", "5");
  assert.equal(h.edits[0]!.text, "Reprocess 1 jot from 2026-10-05?");
});

test("a day with nothing to reprocess says so and offers Back", async () => {
  const h = setup();
  await h.tap("day", "2026", "10", "5");
  assert.equal(h.edits[0]!.text, "No reprocessable jots on 2026-10-05.");
  assert.deepEqual(pairs(h.edits[0]!.kb), [[["‹ Back", "rp:root"]], CLOSE_ROW]);
});

test("a day tap that is not a calendar date is rejected with 'bad date' and no edit", async () => {
  const h = setup();
  await h.tap("day", "2026", "2", "30");
  assert.deepEqual(h.events, ["ack:bad date"]);
  assert.deepEqual(h.edits, []);
});

// --- date range ---

test("a bad range start is rejected before the end calendar is shown", async () => {
  const h = setup();
  await h.tap("range", "2026", "2", "30");
  assert.deepEqual(h.events, ["ack:bad date"]);

  const missing = setup();
  await missing.tap("rangeend", "nonsense", "2026", "10");
  assert.deepEqual(missing.events, ["ack:bad date"]);

  const none = setup();
  await none.tap("rangeend");
  assert.deepEqual(none.events, ["ack:bad date"]);
});

test("picking the range end asks to confirm the whole range", async () => {
  const h = setup({ jotsInRange: async () => [jot(), jot({ anchor: "b" })] });
  await h.tap("rangeend", "2026-10-05", "2026", "10", "9");
  assert.equal(
    h.edits[0]!.text,
    "Reprocess 2 jots from 2026-10-05 to 2026-10-09?",
  );
  assert.equal(
    h.edits[0]!.kb.inline_keyboard[0]![0]!.callback_data,
    "rp:go:r:2026-10-05:2026-10-09",
  );
});

test("an end before the start swaps the range instead of erroring", async () => {
  const h = setup({
    jotsInRange: async (from: number, to: number) => {
      h.ranges.push([from, to]);
      return [jot()];
    },
  });
  await h.tap("rangeend", "2026-10-09", "2026", "10", "5");
  assert.equal(
    h.edits[0]!.text,
    "Reprocess 1 jot from 2026-10-05 to 2026-10-09?",
  );
  assert.equal(
    h.edits[0]!.kb.inline_keyboard[0]![0]!.callback_data,
    "rp:go:r:2026-10-05:2026-10-09",
  );
  assert.deepEqual(h.ranges, [
    [dayBounds("2026-10-05")[0], dayBounds("2026-10-09")[1]],
  ]);
});

test("a range that starts and ends on the same day is still worded and executed as a range", async () => {
  const h = setup({ jotsInRange: async () => [jot()] });
  await h.tap("rangeend", "2026-10-05", "2026", "10", "5");
  assert.equal(
    h.edits[0]!.text,
    "Reprocess 1 jot from 2026-10-05 to 2026-10-05?",
  );
  assert.equal(
    h.edits[0]!.kb.inline_keyboard[0]![0]!.callback_data,
    "rp:go:r:2026-10-05:2026-10-05",
  );

  const empty = setup();
  await empty.tap("rangeend", "2026-10-05", "2026", "10", "5");
  assert.equal(
    empty.edits[0]!.text,
    "No reprocessable jots between 2026-10-05 and 2026-10-05.",
  );

  const go = setup({
    jotsInRange: async () => [jot({ anchor: "a1" })],
    resetForReprocess: async () => ["a1"],
  });
  await go.tap("go", "r", "2026-10-05", "2026-10-05");
  assert.equal(
    go.edits[0]!.text,
    "🔁 Reprocessing 1 jot from 2026-10-05 → 2026-10-05…",
  );
});

test("an empty range names both ends and offers Back", async () => {
  const h = setup();
  await h.tap("rangeend", "2026-10-05", "2026", "10", "9");
  assert.equal(
    h.edits[0]!.text,
    "No reprocessable jots between 2026-10-05 and 2026-10-09.",
  );
  assert.deepEqual(pairs(h.edits[0]!.kb)[0], [["‹ Back", "rp:root"]]);
});

test("a range end with a bad date is rejected with 'bad date'", async () => {
  const h = setup();
  await h.tap("rangeend", "2026-10-05", "2026", "2", "30");
  assert.deepEqual(h.events, ["ack:bad date"]);
  assert.deepEqual(h.edits, []);
});

// --- one jot ---

function jots(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) =>
    jot({
      id: `j${from + i}`,
      anchor: `j${from + i}`,
      raw_text: `entry number ${from + i}`,
      status: i === 1 ? "failed" : "done",
    }),
  );
}

test("the jot picker lists eight jots with status, date, time and preview, plus Next", async () => {
  const h = setup({
    jotsPage: async (offset: number, limit: number) => {
      h.pages.push([offset, limit]);
      return jots(9);
    },
  });
  await h.tap("jot", "0");
  assert.deepEqual(h.pages, [[0, 9]]);
  assert.equal(h.edits[0]!.text, "✉️ Pick a jot to reprocess:");
  const rows = pairs(h.edits[0]!.kb);
  assert.equal(rows.length, 8 + 1 + 1 + 1);
  assert.deepEqual(rows[0], [
    ["✅ 2026-10-05 10:15 entry number 0", "rp:jotpick:j0"],
  ]);
  assert.deepEqual(rows[1], [
    ["❌ 2026-10-05 10:15 entry number 1", "rp:jotpick:j1"],
  ]);
  assert.deepEqual(rows[8], [["Next ›", "rp:jot:1"]]);
  assert.deepEqual(rows[9], [["‹ Back", "rp:root"]]);
});

test("a later page shows Prev, the page number and reads from the right offset", async () => {
  const h = setup({
    jotsPage: async (offset: number, limit: number) => {
      h.pages.push([offset, limit]);
      return jots(3, 8);
    },
  });
  await h.tap("jot", "1");
  assert.deepEqual(h.pages, [[8, 9]]);
  assert.equal(h.edits[0]!.text, "✉️ Pick a jot to reprocess (page 2):");
  const rows = pairs(h.edits[0]!.kb);
  assert.deepEqual(rows[3], [["‹ Prev", "rp:jot:0"]]);
});

test("a long jot is previewed at 40 characters on its button", async () => {
  const h = setup({
    jotsPage: async () => [
      jot({ raw_text: `${"x".repeat(40)}${"y".repeat(160)}` }),
    ],
  });
  await h.tap("jot", "0");
  assert.equal(
    pairs(h.edits[0]!.kb)[0]![0]![0],
    `✅ 2026-10-05 10:15 ${"x".repeat(40)}`,
  );
});

test("a negative or junk page number is clamped to the first page", async () => {
  const h = setup();
  await h.tap("jot", "-5");
  assert.deepEqual(h.pages, [[0, 9]]);
  const junk = setup();
  await junk.tap("jot", "abc");
  assert.deepEqual(junk.pages, [[0, 9]]);
});

test("an empty first page and an empty later page say different things", async () => {
  const first = setup();
  await first.tap("jot", "0");
  assert.equal(first.edits[0]!.text, "No reprocessable jots yet.");
  assert.deepEqual(pairs(first.edits[0]!.kb), [
    [["‹ Back", "rp:root"]],
    CLOSE_ROW,
  ]);

  const later = setup();
  await later.tap("jot", "3");
  assert.equal(later.edits[0]!.text, "No more jots.");
});

test("picking a jot asks to confirm with its preview", async () => {
  const h = setup({ getJot: async () => jot({ id: "j7", anchor: "j7" }) });
  await h.tap("jotpick", "j7");
  assert.equal(h.edits[0]!.text, 'Reprocess "hello world"?');
  assert.deepEqual(pairs(h.edits[0]!.kb), [
    [["🔁 Yes, reprocess", "rp:go:j:j7"]],
    [["Cancel", "rp:cancel"]],
    CLOSE_ROW,
  ]);
});

test("a squashed follower confirms through its leader and says so", async () => {
  const h = setup({ getJot: async () => jot({ id: "f1", anchor: "lead" }) });
  await h.tap("jotpick", "f1");
  assert.equal(
    h.edits[0]!.text,
    'Reprocess "hello world"?\n(part of a squashed entry \u{2014} this reprocesses the whole line)',
  );
  assert.equal(
    h.edits[0]!.kb.inline_keyboard[0]![0]!.callback_data,
    "rp:go:j:lead",
  );
});

test("picking a missing jot answers 'gone' and does not edit", async () => {
  const h = setup();
  await h.tap("jotpick", "nope");
  assert.deepEqual(h.events, ["getJot", "ack:gone"]);
  assert.deepEqual(h.edits, []);

  const noId = setup();
  await noId.tap("jotpick");
  assert.deepEqual(noId.events, ["ack:gone"]);
});

test("a jot that is already pending or processing is refused with a toast", async () => {
  for (const status of ["pending", "processing", "deleted"]) {
    const h = setup({ getJot: async () => jot({ status }) });
    await h.tap("jotpick", "aaaa1111");
    assert.deepEqual(h.events, ["ack:not reprocessable anymore"], status);
    assert.deepEqual(h.edits, []);
  }
});

test("failed and abandoned jots can be picked", async () => {
  for (const status of ["failed", "abandoned"]) {
    const h = setup({ getJot: async () => jot({ status }) });
    await h.tap("jotpick", "aaaa1111");
    assert.equal(h.edits.length, 1, status);
  }
});

// --- execution ---

test("go:d acks first, then reads the day, resets and queues only what was reset", async () => {
  const h = setup({
    jotsInRange: async () => {
      h.events.push("jotsInRange");
      return [
        jot({ anchor: "a1" }),
        jot({ id: "a2", anchor: "a1" }),
        jot({ id: "b1", anchor: "b1" }),
        jot({ id: "c1", anchor: "c1" }),
      ];
    },
    resetForReprocess: async (ids: string[]) => {
      h.events.push("resetForReprocess");
      h.resets.push(ids);
      return ["a1", "c1"];
    },
  });
  await h.tap("go", "d", "2026-10-05");
  assert.deepEqual(h.events, [
    "ack",
    "jotsInRange",
    "resetForReprocess",
    "queue.add",
    "edit",
  ]);
  assert.deepEqual(h.resets, [["a1", "b1", "c1"]]);
  assert.deepEqual(h.queued, [["a1", "c1"]]);
  assert.equal(h.edits[0]!.text, "🔁 Reprocessing 2 jots from 2026-10-05…");
  assert.equal(h.edits[0]!.kb, undefined);
});

test("go:r labels the range with an arrow and swaps a backwards one", async () => {
  const h = setup({
    jotsInRange: async (from: number, to: number) => {
      h.ranges.push([from, to]);
      return [jot({ anchor: "a1" })];
    },
    resetForReprocess: async () => ["a1"],
  });
  await h.tap("go", "r", "2026-10-09", "2026-10-05");
  assert.deepEqual(h.ranges, [
    [dayBounds("2026-10-05")[0], dayBounds("2026-10-09")[1]],
  ]);
  assert.equal(
    h.edits[0]!.text,
    "🔁 Reprocessing 1 jot from 2026-10-05 → 2026-10-09…",
  );
  assert.deepEqual(h.queued, [["a1"]]);
});

test("go:j acks first and reprocesses the jot's leader", async () => {
  const h = setup({
    getJot: async () => {
      h.events.push("getJot");
      return jot({ id: "f1", anchor: "lead" });
    },
    resetForReprocess: async (ids: string[]) => {
      h.events.push("resetForReprocess");
      h.resets.push(ids);
      return ids;
    },
  });
  await h.tap("go", "j", "f1");
  assert.deepEqual(h.events, [
    "ack",
    "getJot",
    "resetForReprocess",
    "queue.add",
    "edit",
  ]);
  assert.deepEqual(h.resets, [["lead"]]);
  assert.deepEqual(h.queued, [["lead"]]);
  assert.equal(h.edits[0]!.text, "🔁 Reprocessing 1 jot from lead…");
});

test("go:j for a jot that vanished edits the message instead of toasting", async () => {
  const h = setup();
  await h.tap("go", "j", "gone1");
  assert.deepEqual(h.events, ["ack", "getJot", "edit"]);
  assert.equal(h.edits[0]!.text, "Jot gone1 not found.");
  assert.deepEqual(h.resets, []);
  assert.deepEqual(h.queued, []);
});

test("go with nothing to reprocess says so and queues nothing", async () => {
  const h = setup();
  await h.tap("go", "d", "2026-10-05");
  assert.equal(h.edits[0]!.text, "No reprocessable jots for 2026-10-05.");
  assert.deepEqual(h.events, ["ack", "jotsInRange", "edit"]);
});

test("go when every target raced out of eligibility reports that and queues nothing", async () => {
  const h = setup({
    jotsInRange: async () => [jot({ anchor: "a1" })],
    resetForReprocess: async () => [],
  });
  await h.tap("go", "d", "2026-10-05");
  assert.equal(
    h.edits[0]!.text,
    "No reprocessable jots for 2026-10-05 anymore.",
  );
  assert.deepEqual(h.queued, []);
});

test("go without a wired queue refuses before resetting any jot to pending", async () => {
  const h = setup(
    { jotsInRange: async () => [jot({ anchor: "a1" })] },
    { queue: false },
  );
  await h.tap("go", "d", "2026-10-05");
  assert.equal(
    h.edits[0]!.text,
    "⚠️ Reprocess isn't ready yet \u{2014} try again in a moment.",
  );
  assert.deepEqual(h.resets, []);
  assert.ok(!h.events.includes("resetForReprocess"));
});

test("go with a malformed payload is toasted without touching the repository", async () => {
  const day = setup();
  await day.tap("go", "d", "2026-13-40");
  assert.deepEqual(day.events, ["ack:bad date"]);

  const dayMissing = setup();
  await dayMissing.tap("go", "d");
  assert.deepEqual(dayMissing.events, ["ack:bad date"]);

  const range = setup();
  await range.tap("go", "r", "2026-10-05", "garbage");
  assert.deepEqual(range.events, ["ack:bad date"]);

  const jotId = setup();
  await jotId.tap("go", "j");
  assert.deepEqual(jotId.events, ["ack:bad jot id"]);
});

test("go with an unknown mode is answered empty and does nothing", async () => {
  const h = setup();
  await h.tap("go", "z", "whatever");
  assert.deepEqual(h.events, ["ack"]);
});

// --- cancel and close ---

test("cancel and close delete the message after answering", async () => {
  for (const action of ["cancel", "close"]) {
    const h = setup();
    await h.tap(action);
    assert.deepEqual(h.events, ["ack", "delete"], action);
    assert.deepEqual(h.edits, []);
  }
});

test("when the message can't be deleted it is replaced by a buttonless 'Cancelled.'", async () => {
  const h = setup({}, { deleteFails: true });
  await h.tap("close");
  assert.equal(h.edits[0]!.text, "Cancelled.");
  assert.deepEqual(h.edits[0]!.kb.inline_keyboard, [[]]);
});

test("closing a message that can be neither deleted nor edited does not throw", async () => {
  const h = setup({}, { deleteFails: true, editFails: true });
  await h.tap("cancel");
  assert.deepEqual(h.events, ["ack"]);
});
