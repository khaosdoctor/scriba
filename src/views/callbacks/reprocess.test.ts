import assert from "node:assert/strict";
import { test } from "node:test";
import { dayBounds } from "../../libs/time.ts";
import {
  botHarness,
  type Harness,
  OWNER,
  type Run,
  sampleJot,
} from "../../test/bot-harness.ts";
import { monthGrid, ROOT_TEXT } from "./reprocess.ts";

const CLOSE_ROW = [["✖ Close", "rp:close"]];
const RECEIVED = new Date(2026, 9, 5, 10, 15).getTime();

const jot = (over: Parameters<typeof sampleJot>[0] = {}) =>
  sampleJot({
    id: "aaaa1111",
    anchor: "aaaa1111",
    time: "10:15",
    raw_text: "hello world",
    received_at: RECEIVED,
    ...over,
  });

const tap = (harness: Harness, ...parts: string[]) =>
  harness.tap(["rp", ...parts].join(":"));

const edit = (run: Run) =>
  run.calls.find((call) => call.method === "editMessageText")?.payload;

const pairs = (payload: { reply_markup?: any } | undefined): string[][][] =>
  (payload?.reply_markup?.inline_keyboard ?? []).map((row: any[]) =>
    row.map((button) => [button.text, button.callback_data]),
  );

const first = (payload: { reply_markup?: any } | undefined) =>
  pairs(payload)[0]?.[0]?.[1];

/** A harness whose range query and reset are recorded on the returned lists. */
async function withRepo(rows: unknown[], reset?: (ids: string[]) => string[]) {
  const harness = await botHarness();
  const ranges: number[][] = [];
  const resets: string[][] = [];
  const queued: string[][] = [];
  harness.repo.jotsInRange = async (from: number, to: number) => {
    ranges.push([from, to]);
    return rows;
  };
  harness.repo.resetForReprocess = async (ids: string[]) => {
    resets.push(ids);
    return reset ? reset(ids) : ids;
  };
  harness.queue.add = (ids: string[]) => void queued.push(ids);
  return { harness, ranges, resets, queued };
}

test("monthGrid pads a month to full weeks starting Sunday", () => {
  // July 2026 starts on a Wednesday and has 31 days.
  const grid = monthGrid(2026, 7);
  assert.equal(grid[0]?.filter((day) => day === 0).length, 3);
  assert.equal(grid[0]?.[3], 1);
  assert.deepEqual(
    grid.flat().filter((day) => day !== 0),
    Array.from({ length: 31 }, (_, index) => index + 1),
  );
  for (const week of grid) assert.equal(week.length, 7);
});

test("the Reprocess entry of /menu posts a fresh picker to the owner", async () => {
  const harness = await botHarness();
  const run = await harness.tap("menu:reprocess");
  const sent = run.calls.find((call) => call.method === "sendMessage")?.payload;
  assert.equal(sent?.chat_id, OWNER);
  assert.equal(sent?.text, ROOT_TEXT);
  assert.equal(sent?.reply_markup.inline_keyboard.length, 4);
});

test("the root tap goes back to the scope picker and noop only answers", async () => {
  const harness = await botHarness();
  const run = await tap(harness, "root");
  assert.equal(edit(run)?.text, ROOT_TEXT);
  assert.equal(first(edit(run)), "rp:day");
  assert.equal((await tap(harness, "noop")).rendered, "ack()");
  assert.equal((await tap(harness, "frobnicate")).rendered, "ack()");
});

// --- calendars ---

test("the day calendar lays out October 2026 Sunday-first with month nav", async () => {
  const run = await tap(await botHarness(), "day", "2026", "10");
  assert.equal(edit(run)?.text, "📅 Pick a day to reprocess (Oct 2026):");
  const rows = pairs(edit(run));
  assert.deepEqual(
    rows[0]?.map((cell) => cell[0]),
    ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
  );
  // Oct 1 2026 is a Thursday: four blank cells, then 1..3.
  assert.deepEqual(
    rows[1]?.map((cell) => cell[0]),
    [" ", " ", " ", " ", "1", "2", "3"],
  );
  assert.deepEqual(rows[1]?.[4], ["1", "rp:day:2026:10:1"]);
  assert.deepEqual(rows[1]?.[0], [" ", "rp:noop"]);
  assert.deepEqual(
    rows[5]?.map((cell) => cell[0]),
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
  const navOf = async (month: string) =>
    pairs(edit(await tap(await botHarness(), "day", "2026", month))).at(-3);
  assert.deepEqual(await navOf("1"), [
    ["‹", "rp:day:2025:12"],
    ["›", "rp:day:2026:2"],
  ]);
  assert.deepEqual(await navOf("12"), [
    ["‹", "rp:day:2026:11"],
    ["›", "rp:day:2027:1"],
  ]);
});

test("a crafted month or year falls back to the current month", async (testContext) => {
  testContext.mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 4, 20).getTime(),
  });
  const titleOf = async (...args: string[]) =>
    edit(await tap(await botHarness(), "day", ...args))?.text;
  assert.equal(
    await titleOf("abc", "13"),
    "📅 Pick a day to reprocess (May 2026):",
  );
  assert.equal(
    await titleOf("42", "3"),
    "📅 Pick a day to reprocess (Mar 2026):",
  );
  assert.equal(await titleOf(), "📅 Pick a day to reprocess (May 2026):");
});

test("the range start calendar carries the range namespace in every callback", async () => {
  const run = await tap(await botHarness(), "range", "2026", "10");
  assert.equal(edit(run)?.text, "📆 Pick the range start (Oct 2026):");
  const rows = pairs(edit(run));
  assert.deepEqual(rows[1]?.[4], ["1", "rp:range:2026:10:1"]);
  assert.deepEqual(rows.at(-3), [
    ["‹", "rp:range:2026:9"],
    ["›", "rp:range:2026:11"],
  ]);
});

test("picking the range start opens the end calendar and keeps the start in every callback", async () => {
  const run = await tap(await botHarness(), "range", "2026", "10", "5");
  assert.equal(
    edit(run)?.text,
    "📆 Start: 2026-10-05. Now pick the range end (Oct 2026):",
  );
  const rows = pairs(edit(run));
  assert.deepEqual(rows[1]?.[4], ["1", "rp:rangeend:2026-10-05:2026:10:1"]);
  assert.deepEqual(rows.at(-3), [
    ["‹", "rp:rangeend:2026-10-05:2026:9"],
    ["›", "rp:rangeend:2026-10-05:2026:11"],
  ]);
});

test("paging the end calendar keeps the start", async () => {
  const run = await tap(
    await botHarness(),
    "rangeend",
    "2026-10-05",
    "2026",
    "11",
  );
  assert.equal(
    edit(run)?.text,
    "📆 Start: 2026-10-05. Pick the range end (Nov 2026):",
  );
  assert.equal(pairs(edit(run))[0]?.length, 7);
});

test("the calendar title names every month with its three-letter English label", async () => {
  const labels: string[] = [];
  for (let month = 1; month <= 12; month++) {
    const text = edit(
      await tap(await botHarness(), "day", "2026", String(month)),
    )?.text as string;
    labels.push(text.slice(text.indexOf("(") + 1, -2));
  }
  assert.deepEqual(labels, [
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
  ]);
});

// --- one day ---

test("tapping a day asks to confirm with the count of distinct targets", async () => {
  const { harness, ranges } = await withRepo([
    jot({ id: "a1", anchor: "a1" }),
    jot({ id: "a2", anchor: "a1" }),
    jot({ id: "b1", anchor: "b1" }),
  ]);
  const run = await tap(harness, "day", "2026", "10", "5");
  assert.deepEqual(ranges, [dayBounds("2026-10-05")]);
  assert.equal(edit(run)?.text, "Reprocess 2 jots from 2026-10-05?");
  assert.deepEqual(pairs(edit(run)), [
    [["🔁 Yes, reprocess 2 jots", "rp:go:d:2026-10-05"]],
    [["Cancel", "rp:cancel"]],
    CLOSE_ROW,
  ]);
});

test("a day with a single target says 'jot', not 'jots'", async () => {
  const { harness } = await withRepo([jot()]);
  const run = await tap(harness, "day", "2026", "10", "5");
  assert.equal(edit(run)?.text, "Reprocess 1 jot from 2026-10-05?");
});

test("a day with nothing to reprocess says so and offers Back", async () => {
  const { harness } = await withRepo([]);
  const run = await tap(harness, "day", "2026", "10", "5");
  assert.equal(edit(run)?.text, "No reprocessable jots on 2026-10-05.");
  assert.deepEqual(pairs(edit(run)), [[["‹ Back", "rp:root"]], CLOSE_ROW]);
});

test("a day tap that is not a calendar date is rejected with 'bad date' and no edit", async () => {
  const run = await tap(await botHarness(), "day", "2026", "2", "30");
  assert.equal(run.rendered, "ack(bad date)");
});

// --- date range ---

test("a bad range start is rejected before the end calendar is shown", async () => {
  const harness = await botHarness();
  assert.equal(
    (await tap(harness, "range", "2026", "2", "30")).rendered,
    "ack(bad date)",
  );
  assert.equal(
    (await tap(harness, "rangeend", "nonsense", "2026", "10")).rendered,
    "ack(bad date)",
  );
  assert.equal((await tap(harness, "rangeend")).rendered, "ack(bad date)");
});

test("picking the range end asks to confirm the whole range", async () => {
  const { harness } = await withRepo([jot(), jot({ anchor: "b" })]);
  const run = await tap(harness, "rangeend", "2026-10-05", "2026", "10", "9");
  assert.equal(
    edit(run)?.text,
    "Reprocess 2 jots from 2026-10-05 to 2026-10-09?",
  );
  assert.equal(first(edit(run)), "rp:go:r:2026-10-05:2026-10-09");
});

test("an end before the start swaps the range instead of erroring", async () => {
  const { harness, ranges } = await withRepo([jot()]);
  const run = await tap(harness, "rangeend", "2026-10-09", "2026", "10", "5");
  assert.equal(
    edit(run)?.text,
    "Reprocess 1 jot from 2026-10-05 to 2026-10-09?",
  );
  assert.equal(first(edit(run)), "rp:go:r:2026-10-05:2026-10-09");
  assert.deepEqual(ranges, [
    [dayBounds("2026-10-05")[0], dayBounds("2026-10-09")[1]],
  ]);
});

test("a range that starts and ends on the same day is still worded and executed as a range", async () => {
  const { harness } = await withRepo([jot({ anchor: "a1" })], () => ["a1"]);
  const run = await tap(harness, "rangeend", "2026-10-05", "2026", "10", "5");
  assert.equal(
    edit(run)?.text,
    "Reprocess 1 jot from 2026-10-05 to 2026-10-05?",
  );
  assert.equal(first(edit(run)), "rp:go:r:2026-10-05:2026-10-05");
  const go = await tap(harness, "go", "r", "2026-10-05", "2026-10-05");
  assert.equal(
    edit(go)?.text,
    "🔁 Reprocessing 1 jot from 2026-10-05 → 2026-10-05…",
  );
});

test("an empty range names both ends and offers Back", async () => {
  const { harness } = await withRepo([]);
  const run = await tap(harness, "rangeend", "2026-10-05", "2026", "10", "9");
  assert.equal(
    edit(run)?.text,
    "No reprocessable jots between 2026-10-05 and 2026-10-09.",
  );
  assert.deepEqual(pairs(edit(run))[0], [["‹ Back", "rp:root"]]);
  const same = await tap(harness, "rangeend", "2026-10-05", "2026", "10", "5");
  assert.equal(
    edit(same)?.text,
    "No reprocessable jots between 2026-10-05 and 2026-10-05.",
  );
});

test("a range end with a bad date is rejected with 'bad date'", async () => {
  const run = await tap(
    await botHarness(),
    "rangeend",
    "2026-10-05",
    "2026",
    "2",
    "30",
  );
  assert.equal(run.rendered, "ack(bad date)");
});

// --- one jot ---

const jots = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) =>
    jot({
      id: `j${from + index}`,
      anchor: `j${from + index}`,
      raw_text: `entry number ${from + index}`,
      status: index === 1 ? "failed" : "done",
    }),
  );

async function withPages(rows: (offset: number) => unknown[]) {
  const harness = await botHarness();
  const asked: number[][] = [];
  harness.repo.jotsPage = async (offset: number, limit: number) => {
    asked.push([offset, limit]);
    return rows(offset);
  };
  return { harness, asked };
}

test("the jot picker lists eight jots with status, date, time and preview, plus Next", async () => {
  const { harness, asked } = await withPages(() => jots(9));
  const run = await tap(harness, "jot", "0");
  assert.deepEqual(asked, [[0, 9]]);
  assert.equal(edit(run)?.text, "✉️ Pick a jot to reprocess:");
  const rows = pairs(edit(run));
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
  const { harness, asked } = await withPages(() => jots(3, 8));
  const run = await tap(harness, "jot", "1");
  assert.deepEqual(asked, [[8, 9]]);
  assert.equal(edit(run)?.text, "✉️ Pick a jot to reprocess (page 2):");
  assert.deepEqual(pairs(edit(run))[3], [["‹ Prev", "rp:jot:0"]]);
});

test("a long jot is previewed at 40 characters on its button", async () => {
  const { harness } = await withPages(() => [
    jot({ raw_text: `${"x".repeat(40)}${"y".repeat(160)}` }),
  ]);
  const run = await tap(harness, "jot", "0");
  assert.equal(
    pairs(edit(run))[0]?.[0]?.[0],
    `✅ 2026-10-05 10:15 ${"x".repeat(40)}`,
  );
});

test("a negative or junk page number is clamped to the first page", async () => {
  const { harness, asked } = await withPages(() => []);
  await tap(harness, "jot", "-5");
  await tap(harness, "jot", "abc");
  assert.deepEqual(asked, [
    [0, 9],
    [0, 9],
  ]);
});

test("an empty first page and an empty later page say different things", async () => {
  const { harness } = await withPages(() => []);
  const firstPage = await tap(harness, "jot", "0");
  assert.equal(edit(firstPage)?.text, "No reprocessable jots yet.");
  assert.deepEqual(pairs(edit(firstPage)), [
    [["‹ Back", "rp:root"]],
    CLOSE_ROW,
  ]);
  assert.equal(edit(await tap(harness, "jot", "3"))?.text, "No more jots.");
});

test("picking a jot asks to confirm with its preview", async () => {
  const harness = await botHarness();
  harness.repo.getJot = jot({ id: "j7", anchor: "j7" });
  const run = await tap(harness, "jotpick", "j7");
  assert.equal(edit(run)?.text, 'Reprocess "hello world"?');
  assert.deepEqual(pairs(edit(run)), [
    [["🔁 Yes, reprocess", "rp:go:j:j7"]],
    [["Cancel", "rp:cancel"]],
    CLOSE_ROW,
  ]);
});

test("a squashed follower confirms through its leader and says so", async () => {
  const harness = await botHarness();
  harness.repo.getJot = jot({ id: "f1", anchor: "lead" });
  const run = await tap(harness, "jotpick", "f1");
  assert.equal(
    edit(run)?.text,
    'Reprocess "hello world"?\n(part of a squashed entry — this reprocesses the whole line)',
  );
  assert.equal(first(edit(run)), "rp:go:j:lead");
});

test("picking a missing jot answers 'gone' and does not edit", async () => {
  const harness = await botHarness();
  assert.equal(
    (await tap(harness, "jotpick", "nope")).rendered,
    "repo.getJot > ack(gone)",
  );
  assert.equal((await tap(harness, "jotpick")).rendered, "ack(gone)");
});

test("a jot that is already pending or processing is refused with a toast", async () => {
  for (const status of ["pending", "processing", "deleted"] as const) {
    const harness = await botHarness();
    harness.repo.getJot = jot({ status });
    const run = await tap(harness, "jotpick", "aaaa1111");
    assert.equal(run.rendered, "repo.getJot > ack(not reprocessable anymore)");
  }
});

test("failed and abandoned jots can be picked", async () => {
  for (const status of ["failed", "abandoned"] as const) {
    const harness = await botHarness();
    harness.repo.getJot = jot({ status });
    assert.ok(edit(await tap(harness, "jotpick", "aaaa1111")), status);
  }
});

// --- execution ---

test("go:d reads the day, resets its distinct leaders and queues only what was reset", async () => {
  const { harness, resets, queued } = await withRepo(
    [
      jot({ anchor: "a1" }),
      jot({ id: "a2", anchor: "a1" }),
      jot({ id: "b1", anchor: "b1" }),
      jot({ id: "c1", anchor: "c1" }),
    ],
    () => ["a1", "c1"],
  );
  const run = await tap(harness, "go", "d", "2026-10-05");
  assert.deepEqual(resets, [["a1", "b1", "c1"]]);
  assert.deepEqual(queued, [["a1", "c1"]]);
  assert.equal(edit(run)?.text, "🔁 Reprocessing 2 jots from 2026-10-05…");
  assert.equal(edit(run)?.reply_markup, undefined);
});

test("go:r labels the range with an arrow and swaps a backwards one", async () => {
  const { harness, ranges, queued } = await withRepo(
    [jot({ anchor: "a1" })],
    () => ["a1"],
  );
  const run = await tap(harness, "go", "r", "2026-10-09", "2026-10-05");
  assert.deepEqual(ranges, [
    [dayBounds("2026-10-05")[0], dayBounds("2026-10-09")[1]],
  ]);
  assert.equal(
    edit(run)?.text,
    "🔁 Reprocessing 1 jot from 2026-10-05 → 2026-10-09…",
  );
  assert.deepEqual(queued, [["a1"]]);
});

test("go:j reprocesses the jot's leader", async () => {
  const { harness, resets, queued } = await withRepo([]);
  harness.repo.getJot = jot({ id: "f1", anchor: "lead" });
  const run = await tap(harness, "go", "j", "f1");
  assert.deepEqual(resets, [["lead"]]);
  assert.deepEqual(queued, [["lead"]]);
  assert.equal(edit(run)?.text, "🔁 Reprocessing 1 jot from lead…");
});

test("go:j for a jot that vanished edits the message instead of toasting", async () => {
  const { harness, resets, queued } = await withRepo([]);
  const run = await tap(harness, "go", "j", "gone1");
  assert.equal(edit(run)?.text, "Jot gone1 not found.");
  assert.deepEqual(pairs(edit(run))[0], [["‹ Back", "rp:root"]]);
  assert.deepEqual([resets, queued], [[], []]);
});

test("go with nothing to reprocess says so and queues nothing", async () => {
  const { harness, queued } = await withRepo([]);
  const run = await tap(harness, "go", "d", "2026-10-05");
  assert.equal(edit(run)?.text, "No reprocessable jots for 2026-10-05.");
  assert.deepEqual(queued, []);
});

test("go when every target raced out of eligibility reports that and queues nothing", async () => {
  const { harness, queued } = await withRepo([jot({ anchor: "a1" })], () => []);
  const run = await tap(harness, "go", "d", "2026-10-05");
  assert.equal(
    edit(run)?.text,
    "No reprocessable jots for 2026-10-05 anymore.",
  );
  assert.deepEqual(queued, []);
});

test("go with a malformed payload is toasted without touching the repository", async () => {
  const harness = await botHarness();
  for (const [parts, toast] of [
    [["d", "2026-13-40"], "bad date"],
    [["d"], "bad date"],
    [["r", "2026-10-05", "garbage"], "bad date"],
    [["j"], "bad jot id"],
  ] as const)
    assert.equal(
      (await tap(harness, "go", ...parts)).rendered,
      `ack(${toast})`,
      parts.join(":"),
    );
});

test("go with an unknown mode is answered empty and does nothing", async () => {
  const run = await tap(await botHarness(), "go", "z", "whatever");
  assert.equal(run.rendered, "ack()");
});

// --- cancel and close ---

test("cancel and close delete the message after answering", async () => {
  for (const action of ["cancel", "close"]) {
    const run = await tap(await botHarness(), action);
    assert.equal(run.rendered, "ack() > tg.deleteMessage", action);
  }
});

test("when the message can't be deleted it is replaced by a buttonless 'Cancelled.'", async () => {
  const harness = await botHarness();
  harness.failApi.add("deleteMessage");
  const run = await tap(harness, "close");
  assert.equal(edit(run)?.text, "Cancelled.");
  assert.deepEqual(edit(run)?.reply_markup.inline_keyboard, [[]]);
});

test("closing a message that can be neither deleted nor edited does not fail the tap", async () => {
  const harness = await botHarness();
  harness.failApi.add("deleteMessage");
  harness.failApi.add("editMessageText");
  const run = await tap(harness, "cancel");
  assert.equal(run.rendered, "ack() > tg.deleteMessage > tg.editMessageText");
});
