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
    row.map((button) => [button.text, button.callback_data]),
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
  const commands: Record<string, (ctx: any) => Promise<void>> = {};
  const bot = {
    command: (name: string, fn: (ctx: any) => Promise<void>) => {
      commands[name] = fn;
    },
    api: {
      sendMessage: async (chat: number, text: string, options: any) => {
        sent.push({ chat, text, kb: options.reply_markup });
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
    answerCallbackQuery: async (answer?: { text: string }) => {
      events.push(answer?.text ? `ack:${answer.text}` : "ack");
    },
    editMessageText: async (text: string, options?: any) => {
      if (opts.editFails) throw new Error("message can't be edited");
      events.push("edit");
      edits.push({ text, kb: options?.reply_markup });
    },
    deleteMessage: async () => {
      if (opts.deleteFails) throw new Error("message can't be deleted");
      events.push("delete");
    },
    reply: async (text: string, options: any) => {
      sent.push({ chat: -1, text, kb: options.reply_markup });
    },
  };
  const tap = (...rest: string[]) => (reprocess as any).handleTap(ctx, rest);
  return {
    reprocess,
    commands,
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
  const fixture = setup();
  fixture.reprocess.register();
  await fixture.commands.reprocess!(fixture.ctx);
  assert.equal(fixture.sent[0]!.text, ROOT_TEXT);
  assert.deepEqual(pairs(fixture.sent[0]!.kb), [
    [["📅 One day", "rp:day"]],
    [["📆 Date range", "rp:range"]],
    [["✉️ One jot", "rp:jot:0"]],
    ...[CLOSE_ROW],
  ]);
});

test("/menu's Reprocess entry posts a fresh picker to the owner", async () => {
  const fixture = setup();
  await fixture.reprocess.promptRoot();
  assert.equal(fixture.sent[0]!.chat, config.telegram.allowedUserId);
  assert.equal(fixture.sent[0]!.text, ROOT_TEXT);
  assert.equal(fixture.sent[0]!.kb.inline_keyboard.length, 4);
});

test("the root tap goes back to the scope picker, noop answers and nothing else", async () => {
  const fixture = setup();
  await fixture.tap("root");
  assert.deepEqual(fixture.events, ["ack", "edit"]);
  assert.equal(fixture.edits[0]!.text, ROOT_TEXT);
  assert.equal(
    fixture.edits[0]!.kb.inline_keyboard[0]![0]!.callback_data,
    "rp:day",
  );

  const noopFixture = setup();
  await noopFixture.tap("noop");
  assert.deepEqual(noopFixture.events, ["ack"]);
});

test("an unknown action is answered empty and ignored", async () => {
  const fixture = setup();
  await fixture.tap("frobnicate");
  assert.deepEqual(fixture.events, ["ack"]);
});

// --- calendars ---

test("the day calendar lays out October 2026 Sunday-first with month nav", async () => {
  const fixture = setup();
  await fixture.tap("day", "2026", "10");
  assert.deepEqual(fixture.events, ["ack", "edit"]);
  assert.equal(
    fixture.edits[0]!.text,
    "📅 Pick a day to reprocess (Oct 2026):",
  );
  const rows = pairs(fixture.edits[0]!.kb);
  assert.deepEqual(
    rows[0]!.map((cell) => cell[0]),
    ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
  );
  // Oct 1 2026 is a Thursday: four blank cells, then 1..3.
  assert.deepEqual(
    rows[1]!.map((cell) => cell[0]),
    [" ", " ", " ", " ", "1", "2", "3"],
  );
  assert.deepEqual(rows[1]![4], ["1", "rp:day:2026:10:1"]);
  assert.deepEqual(rows[1]![0], [" ", "rp:noop"]);
  assert.deepEqual(
    rows[5]!.map((cell) => cell[0]),
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

test("a crafted month or year falls back to the current month", async (testContext) => {
  testContext.mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 4, 20).getTime(),
  });
  const fixture = setup();
  await fixture.tap("day", "abc", "13");
  assert.equal(
    fixture.edits[0]!.text,
    "📅 Pick a day to reprocess (May 2026):",
  );
  const years = setup();
  await years.tap("day", "42", "3");
  assert.equal(years.edits[0]!.text, "📅 Pick a day to reprocess (Mar 2026):");
  const bare = setup();
  await bare.tap("day");
  assert.equal(bare.edits[0]!.text, "📅 Pick a day to reprocess (May 2026):");
});

test("the range start calendar carries the range namespace in every callback", async () => {
  const fixture = setup();
  await fixture.tap("range", "2026", "10");
  assert.deepEqual(fixture.events, ["ack", "edit"]);
  assert.equal(fixture.edits[0]!.text, "📆 Pick the range start (Oct 2026):");
  const rows = pairs(fixture.edits[0]!.kb);
  assert.deepEqual(rows[1]![4], ["1", "rp:range:2026:10:1"]);
  assert.deepEqual(rows.at(-3), [
    ["‹", "rp:range:2026:9"],
    ["›", "rp:range:2026:11"],
  ]);
});

test("picking the range start opens the end calendar and keeps the start in every callback", async () => {
  const fixture = setup();
  await fixture.tap("range", "2026", "10", "5");
  assert.equal(
    fixture.edits[0]!.text,
    "📆 Start: 2026-10-05. Now pick the range end (Oct 2026):",
  );
  const rows = pairs(fixture.edits[0]!.kb);
  assert.deepEqual(rows[1]![4], ["1", "rp:rangeend:2026-10-05:2026:10:1"]);
  assert.deepEqual(rows.at(-3), [
    ["‹", "rp:rangeend:2026-10-05:2026:9"],
    ["›", "rp:rangeend:2026-10-05:2026:11"],
  ]);
});

test("paging the end calendar keeps the start", async () => {
  const fixture = setup();
  await fixture.tap("rangeend", "2026-10-05", "2026", "11");
  assert.equal(
    fixture.edits[0]!.text,
    "📆 Start: 2026-10-05. Pick the range end (Nov 2026):",
  );
  assert.deepEqual(pairs(fixture.edits[0]!.kb)[0]!.length, 7);
});

// --- one day ---

test("tapping a day asks to confirm with the count of distinct targets", async () => {
  const rows = [
    jot({ id: "a1", anchor: "a1" }),
    jot({ id: "a2", anchor: "a1" }),
    jot({ id: "b1", anchor: "b1" }),
  ];
  const fixture = setup({
    jotsInRange: async (from: number, to: number) => {
      fixture.ranges.push([from, to]);
      return rows;
    },
  });
  await fixture.tap("day", "2026", "10", "5");
  assert.deepEqual(fixture.ranges, [dayBounds("2026-10-05")]);
  assert.equal(fixture.edits[0]!.text, "Reprocess 2 jots from 2026-10-05?");
  assert.deepEqual(pairs(fixture.edits[0]!.kb), [
    [["🔁 Yes, reprocess 2 jots", "rp:go:d:2026-10-05"]],
    [["Cancel", "rp:cancel"]],
    CLOSE_ROW,
  ]);
});

test("a day with a single target says 'jot', not 'jots'", async () => {
  const fixture = setup({ jotsInRange: async () => [jot()] });
  await fixture.tap("day", "2026", "10", "5");
  assert.equal(fixture.edits[0]!.text, "Reprocess 1 jot from 2026-10-05?");
});

test("a day with nothing to reprocess says so and offers Back", async () => {
  const fixture = setup();
  await fixture.tap("day", "2026", "10", "5");
  assert.equal(fixture.edits[0]!.text, "No reprocessable jots on 2026-10-05.");
  assert.deepEqual(pairs(fixture.edits[0]!.kb), [
    [["‹ Back", "rp:root"]],
    CLOSE_ROW,
  ]);
});

test("a day tap that is not a calendar date is rejected with 'bad date' and no edit", async () => {
  const fixture = setup();
  await fixture.tap("day", "2026", "2", "30");
  assert.deepEqual(fixture.events, ["ack:bad date"]);
  assert.deepEqual(fixture.edits, []);
});

// --- date range ---

test("a bad range start is rejected before the end calendar is shown", async () => {
  const fixture = setup();
  await fixture.tap("range", "2026", "2", "30");
  assert.deepEqual(fixture.events, ["ack:bad date"]);

  const missing = setup();
  await missing.tap("rangeend", "nonsense", "2026", "10");
  assert.deepEqual(missing.events, ["ack:bad date"]);

  const none = setup();
  await none.tap("rangeend");
  assert.deepEqual(none.events, ["ack:bad date"]);
});

test("picking the range end asks to confirm the whole range", async () => {
  const fixture = setup({
    jotsInRange: async () => [jot(), jot({ anchor: "b" })],
  });
  await fixture.tap("rangeend", "2026-10-05", "2026", "10", "9");
  assert.equal(
    fixture.edits[0]!.text,
    "Reprocess 2 jots from 2026-10-05 to 2026-10-09?",
  );
  assert.equal(
    fixture.edits[0]!.kb.inline_keyboard[0]![0]!.callback_data,
    "rp:go:r:2026-10-05:2026-10-09",
  );
});

test("an end before the start swaps the range instead of erroring", async () => {
  const fixture = setup({
    jotsInRange: async (from: number, to: number) => {
      fixture.ranges.push([from, to]);
      return [jot()];
    },
  });
  await fixture.tap("rangeend", "2026-10-09", "2026", "10", "5");
  assert.equal(
    fixture.edits[0]!.text,
    "Reprocess 1 jot from 2026-10-05 to 2026-10-09?",
  );
  assert.equal(
    fixture.edits[0]!.kb.inline_keyboard[0]![0]!.callback_data,
    "rp:go:r:2026-10-05:2026-10-09",
  );
  assert.deepEqual(fixture.ranges, [
    [dayBounds("2026-10-05")[0], dayBounds("2026-10-09")[1]],
  ]);
});

test("an empty range names both ends and offers Back", async () => {
  const fixture = setup();
  await fixture.tap("rangeend", "2026-10-05", "2026", "10", "9");
  assert.equal(
    fixture.edits[0]!.text,
    "No reprocessable jots between 2026-10-05 and 2026-10-09.",
  );
  assert.deepEqual(pairs(fixture.edits[0]!.kb)[0], [["‹ Back", "rp:root"]]);
});

test("a range end with a bad date is rejected with 'bad date'", async () => {
  const fixture = setup();
  await fixture.tap("rangeend", "2026-10-05", "2026", "2", "30");
  assert.deepEqual(fixture.events, ["ack:bad date"]);
  assert.deepEqual(fixture.edits, []);
});

// --- one jot ---

function jots(count: number, from = 0) {
  return Array.from({ length: count }, (_, index) =>
    jot({
      id: `j${from + index}`,
      anchor: `j${from + index}`,
      raw_text: `entry number ${from + index}`,
      status: index === 1 ? "failed" : "done",
    }),
  );
}

test("the jot picker lists eight jots with status, date, time and preview, plus Next", async () => {
  const fixture = setup({
    jotsPage: async (offset: number, limit: number) => {
      fixture.pages.push([offset, limit]);
      return jots(9);
    },
  });
  await fixture.tap("jot", "0");
  assert.deepEqual(fixture.pages, [[0, 9]]);
  assert.equal(fixture.edits[0]!.text, "✉️ Pick a jot to reprocess:");
  const rows = pairs(fixture.edits[0]!.kb);
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
  const fixture = setup({
    jotsPage: async (offset: number, limit: number) => {
      fixture.pages.push([offset, limit]);
      return jots(3, 8);
    },
  });
  await fixture.tap("jot", "1");
  assert.deepEqual(fixture.pages, [[8, 9]]);
  assert.equal(fixture.edits[0]!.text, "✉️ Pick a jot to reprocess (page 2):");
  const rows = pairs(fixture.edits[0]!.kb);
  assert.deepEqual(rows[3], [["‹ Prev", "rp:jot:0"]]);
});

test("a long jot is previewed at 40 characters on its button", async () => {
  const fixture = setup({
    jotsPage: async () => [
      jot({ raw_text: `${"x".repeat(40)}${"y".repeat(160)}` }),
    ],
  });
  await fixture.tap("jot", "0");
  assert.equal(
    pairs(fixture.edits[0]!.kb)[0]![0]![0],
    `✅ 2026-10-05 10:15 ${"x".repeat(40)}`,
  );
});

test("a negative or junk page number is clamped to the first page", async () => {
  const fixture = setup();
  await fixture.tap("jot", "-5");
  assert.deepEqual(fixture.pages, [[0, 9]]);
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
  const fixture = setup({
    getJot: async () => jot({ id: "j7", anchor: "j7" }),
  });
  await fixture.tap("jotpick", "j7");
  assert.equal(fixture.edits[0]!.text, 'Reprocess "hello world"?');
  assert.deepEqual(pairs(fixture.edits[0]!.kb), [
    [["🔁 Yes, reprocess", "rp:go:j:j7"]],
    [["Cancel", "rp:cancel"]],
    CLOSE_ROW,
  ]);
});

test("a squashed follower confirms through its leader and says so", async () => {
  const fixture = setup({
    getJot: async () => jot({ id: "f1", anchor: "lead" }),
  });
  await fixture.tap("jotpick", "f1");
  assert.equal(
    fixture.edits[0]!.text,
    'Reprocess "hello world"?\n(part of a squashed entry \u{2014} this reprocesses the whole line)',
  );
  assert.equal(
    fixture.edits[0]!.kb.inline_keyboard[0]![0]!.callback_data,
    "rp:go:j:lead",
  );
});

test("picking a missing jot answers 'gone' and does not edit", async () => {
  const fixture = setup();
  await fixture.tap("jotpick", "nope");
  assert.deepEqual(fixture.events, ["getJot", "ack:gone"]);
  assert.deepEqual(fixture.edits, []);

  const noId = setup();
  await noId.tap("jotpick");
  assert.deepEqual(noId.events, ["ack:gone"]);
});

test("a jot that is already pending or processing is refused with a toast", async () => {
  for (const status of ["pending", "processing", "deleted"]) {
    const fixture = setup({ getJot: async () => jot({ status }) });
    await fixture.tap("jotpick", "aaaa1111");
    assert.deepEqual(fixture.events, ["ack:not reprocessable anymore"], status);
    assert.deepEqual(fixture.edits, []);
  }
});

test("failed and abandoned jots can be picked", async () => {
  for (const status of ["failed", "abandoned"]) {
    const fixture = setup({ getJot: async () => jot({ status }) });
    await fixture.tap("jotpick", "aaaa1111");
    assert.equal(fixture.edits.length, 1, status);
  }
});

// --- execution ---

test("go:d acks first, then reads the day, resets and queues only what was reset", async () => {
  const fixture = setup({
    jotsInRange: async () => {
      fixture.events.push("jotsInRange");
      return [
        jot({ anchor: "a1" }),
        jot({ id: "a2", anchor: "a1" }),
        jot({ id: "b1", anchor: "b1" }),
        jot({ id: "c1", anchor: "c1" }),
      ];
    },
    resetForReprocess: async (ids: string[]) => {
      fixture.events.push("resetForReprocess");
      fixture.resets.push(ids);
      return ["a1", "c1"];
    },
  });
  await fixture.tap("go", "d", "2026-10-05");
  assert.deepEqual(fixture.events, [
    "ack",
    "jotsInRange",
    "resetForReprocess",
    "queue.add",
    "edit",
  ]);
  assert.deepEqual(fixture.resets, [["a1", "b1", "c1"]]);
  assert.deepEqual(fixture.queued, [["a1", "c1"]]);
  assert.equal(
    fixture.edits[0]!.text,
    "🔁 Reprocessing 2 jots from 2026-10-05…",
  );
  assert.equal(fixture.edits[0]!.kb, undefined);
});

test("go:r labels the range with an arrow and swaps a backwards one", async () => {
  const fixture = setup({
    jotsInRange: async (from: number, to: number) => {
      fixture.ranges.push([from, to]);
      return [jot({ anchor: "a1" })];
    },
    resetForReprocess: async () => ["a1"],
  });
  await fixture.tap("go", "r", "2026-10-09", "2026-10-05");
  assert.deepEqual(fixture.ranges, [
    [dayBounds("2026-10-05")[0], dayBounds("2026-10-09")[1]],
  ]);
  assert.equal(
    fixture.edits[0]!.text,
    "🔁 Reprocessing 1 jot from 2026-10-05 → 2026-10-09…",
  );
  assert.deepEqual(fixture.queued, [["a1"]]);
});

test("go:j acks first and reprocesses the jot's leader", async () => {
  const fixture = setup({
    getJot: async () => {
      fixture.events.push("getJot");
      return jot({ id: "f1", anchor: "lead" });
    },
    resetForReprocess: async (ids: string[]) => {
      fixture.events.push("resetForReprocess");
      fixture.resets.push(ids);
      return ids;
    },
  });
  await fixture.tap("go", "j", "f1");
  assert.deepEqual(fixture.events, [
    "ack",
    "getJot",
    "resetForReprocess",
    "queue.add",
    "edit",
  ]);
  assert.deepEqual(fixture.resets, [["lead"]]);
  assert.deepEqual(fixture.queued, [["lead"]]);
  assert.equal(fixture.edits[0]!.text, "🔁 Reprocessing 1 jot from lead…");
});

test("go:j for a jot that vanished edits the message instead of toasting", async () => {
  const fixture = setup();
  await fixture.tap("go", "j", "gone1");
  assert.deepEqual(fixture.events, ["ack", "getJot", "edit"]);
  assert.equal(fixture.edits[0]!.text, "Jot gone1 not found.");
  assert.deepEqual(fixture.resets, []);
  assert.deepEqual(fixture.queued, []);
});

test("go with nothing to reprocess says so and queues nothing", async () => {
  const fixture = setup();
  await fixture.tap("go", "d", "2026-10-05");
  assert.equal(fixture.edits[0]!.text, "No reprocessable jots for 2026-10-05.");
  assert.deepEqual(fixture.events, ["ack", "jotsInRange", "edit"]);
});

test("go when every target raced out of eligibility reports that and queues nothing", async () => {
  const fixture = setup({
    jotsInRange: async () => [jot({ anchor: "a1" })],
    resetForReprocess: async () => [],
  });
  await fixture.tap("go", "d", "2026-10-05");
  assert.equal(
    fixture.edits[0]!.text,
    "No reprocessable jots for 2026-10-05 anymore.",
  );
  assert.deepEqual(fixture.queued, []);
});

test("go without a wired queue refuses before resetting any jot to pending", async () => {
  const fixture = setup(
    { jotsInRange: async () => [jot({ anchor: "a1" })] },
    { queue: false },
  );
  await fixture.tap("go", "d", "2026-10-05");
  assert.equal(
    fixture.edits[0]!.text,
    "⚠️ Reprocess isn't ready yet \u{2014} try again in a moment.",
  );
  assert.deepEqual(fixture.resets, []);
  assert.ok(!fixture.events.includes("resetForReprocess"));
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
  const fixture = setup();
  await fixture.tap("go", "z", "whatever");
  assert.deepEqual(fixture.events, ["ack"]);
});

// --- cancel and close ---

test("cancel and close delete the message after answering", async () => {
  for (const action of ["cancel", "close"]) {
    const fixture = setup();
    await fixture.tap(action);
    assert.deepEqual(fixture.events, ["ack", "delete"], action);
    assert.deepEqual(fixture.edits, []);
  }
});

test("when the message can't be deleted it is replaced by a buttonless 'Cancelled.'", async () => {
  const fixture = setup({}, { deleteFails: true });
  await fixture.tap("close");
  assert.equal(fixture.edits[0]!.text, "Cancelled.");
  assert.deepEqual(fixture.edits[0]!.kb.inline_keyboard, [[]]);
});

test("closing a message that can be neither deleted nor edited does not throw", async () => {
  const fixture = setup({}, { deleteFails: true, editFails: true });
  await fixture.tap("cancel");
  assert.deepEqual(fixture.events, ["ack"]);
});
