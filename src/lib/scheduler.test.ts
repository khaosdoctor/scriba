import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeSettings } from "../test/fakes.ts";

// scheduler.ts pulls in config.ts, which validates process.env at import time, so give it
// the bare minimum before loading, the same trick config.test.ts uses.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { Scheduler } = await import("./scheduler.ts");
const { plainDate } = await import("./time.ts");

const DAY = 24 * 60 * 60_000;

/** Hand back to the event loop so the awaits inside a fired timer can settle. Mock timers
 *  move the clock, not the microtask queue. */
const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

type Stats = {
  total: number;
  audio: number;
  failed: number;
  abandoned: number;
};

function harness(
  stats: Partial<Stats> = {},
  sweep?: () => Promise<void>,
  settings: Map<string, string> | Record<string, string> = {},
) {
  const notified: string[] = [];
  const rated: string[] = [];
  const habits: string[] = [];
  const summaries: string[] = [];
  let sweeps = 0;
  const repo = {
    ...new FakeSettings(settings),
    windowStats: async (): Promise<Stats> => ({
      total: 0,
      audio: 0,
      failed: 0,
      abandoned: 0,
      ...stats,
    }),
  };
  const processor = {
    retrySweep: async () => {
      sweeps++;
      if (sweep) await sweep();
    },
  };
  const scheduler = new Scheduler(
    repo as any,
    processor as any,
    async (text: string) => void notified.push(text),
    async (date: string) => void rated.push(date),
    async (date: string) => void habits.push(date),
    async () => void summaries.push(plainDate()),
    1000, // retry interval, in mock-clock ms
  );
  return {
    scheduler,
    notified,
    rated,
    habits,
    summaries,
    sweeps: () => sweeps,
  };
}

test("the retry sweep runs on its interval and stops when the scheduler does", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness();
  h.scheduler.start();

  // A tick at a time, letting each sweep settle: two firings inside one synchronous tick
  // would collapse into one, which is the overlap guard doing its job (see below).
  for (let i = 1; i <= 3; i++) {
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(h.sweeps(), i);
  }

  h.scheduler.stop();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(h.sweeps(), 3);
});

test("a slow sweep doesn't stack up behind itself", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const h = harness({}, () => held);
  h.scheduler.start();

  // Three ticks while the first sweep is still running: the guard should hold them off,
  // or a sweep slower than the interval would pile stacks on the same pending jots.
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(h.sweeps(), 1);

  release();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.sweeps(), 2);
});

test("a sweep that throws is logged and the next one still runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let boom = true;
  const h = harness({}, async () => {
    if (boom) throw new Error("obsidian is down");
  });
  h.scheduler.start();

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.sweeps(), 1);
  // The guard is cleared in a finally: without it one failure stops the retry pass forever.
  boom = false;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.sweeps(), 2);
});

test("the morning task summary fires daily, on its own schedule", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness();
  h.scheduler.start();

  // Its time (09:00 by default) falls somewhere inside any 24h window, whatever "now" is.
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.summaries.length, 1);

  // Re-armed, so it goes out every morning rather than once after a deploy.
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.summaries.length, 2);

  h.scheduler.stop();
  t.mock.timers.tick(DAY * 2);
  await flush();
  assert.equal(h.summaries.length, 2);
});

test("the nightly prompts fire for the day that just ended, then re-arm", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness();
  h.scheduler.start();

  // Both prompts default to 00:00, so a full day's tick lands on them whatever "now" is.
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.rated.length, 1);
  assert.equal(h.habits.length, 1);
  assert.match(h.rated[0]!, /^\d{4}-\d{2}-\d{2}$/);

  // Re-armed for tomorrow rather than firing once and going quiet.
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.rated.length, 2);
  assert.equal(h.habits.length, 2);
});

test("the nightly rating is skipped while its switch is off, the habit review is not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness({}, undefined, { nightlyRating: "off" });
  h.scheduler.start();
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.rated.length, 0);
  assert.equal(h.habits.length, 1);

  // Skipping still re-arms, so turning it back on needs no restart.
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.rated.length, 0);
});

test("changing the rating time re-arms it, and a later time rates the day still going", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness();
  h.scheduler.setRatingTime("23:59");
  h.scheduler.start();
  // Move it while running: only the new time fires, once per day.
  h.scheduler.setRatingTime("22:00");
  t.mock.timers.tick(DAY);
  await flush();
  assert.deepEqual(h.rated, [plainDate()]);
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.rated.length, 2);
  h.scheduler.stop();
});

test("a prompt that throws still re-arms for tomorrow", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0;
  const scheduler = new Scheduler(
    {
      windowStats: async () => ({ total: 0 }),
      getSetting: async () => true,
    } as any,
    { retrySweep: async () => {} } as any,
    async () => {},
    async () => {
      calls++;
      throw new Error("telegram is down");
    },
    async () => {},
    async () => {},
    1000,
  );
  scheduler.start();

  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(calls, 2);
  scheduler.stop();
});

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Mock timers and the clock together, starting at 10:00 local on 2026-03-10. */
function clockAt10(t: { mock: { timers: { enable: (o: any) => void } } }) {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: new Date(2026, 2, 10, 10, 0).getTime(),
  });
}

test("a stopped scheduler never fires the rating or the habit review", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness();
  h.scheduler.start();
  h.scheduler.stop();
  t.mock.timers.tick(3 * DAY);
  await flush();
  assert.equal(h.rated.length, 0);
  assert.equal(h.habits.length, 0);
});

test("a rating time set before start only records it, and the first firing uses it", async (t) => {
  clockAt10(t);
  const h = harness();
  h.scheduler.setRatingTime("22:00");
  t.mock.timers.tick(3 * DAY);
  await flush();
  assert.equal(h.rated.length, 0);

  // Fresh clock: the tick above moved it.
  t.mock.timers.reset();
  clockAt10(t);
  const fresh = harness();
  fresh.scheduler.setRatingTime("22:00");
  fresh.scheduler.start();
  t.mock.timers.tick(11 * HOUR + 59 * MIN);
  await flush();
  assert.deepEqual(fresh.rated, []);
  t.mock.timers.tick(MIN);
  await flush();
  assert.deepEqual(fresh.rated, ["2026-03-10"]);
  fresh.scheduler.stop();
});

test("changing the rating time again and again leaves one timer, at the last time", async (t) => {
  clockAt10(t);
  const h = harness();
  h.scheduler.start();
  h.scheduler.setRatingTime("12:00");
  h.scheduler.setRatingTime("13:00");
  h.scheduler.setRatingTime("13:00");
  t.mock.timers.tick(2 * HOUR + 30 * MIN); // 12:30, past the abandoned 12:00
  await flush();
  assert.deepEqual(h.rated, []);
  t.mock.timers.tick(30 * MIN); // 13:00
  await flush();
  assert.deepEqual(h.rated, ["2026-03-10"]);
  h.scheduler.stop();
});

test("setRatingTime normalises an unpadded time and ignores an invalid one", async (t) => {
  clockAt10(t);
  const h = harness();
  h.scheduler.setRatingTime("9:30"); // before 10:00, so the next firing is tomorrow 09:30
  h.scheduler.setRatingTime("25:99"); // rejected, 09:30 stays
  h.scheduler.start();
  t.mock.timers.tick(23 * HOUR + 29 * MIN);
  await flush();
  assert.deepEqual(h.rated, []);
  t.mock.timers.tick(MIN);
  await flush();
  assert.deepEqual(h.rated, ["2026-03-10"]);
  h.scheduler.stop();
});

test("a midnight rating is for the day that just ended, by exact date", async (t) => {
  clockAt10(t);
  const h = harness();
  h.scheduler.start();
  t.mock.timers.tick(14 * HOUR); // 00:00 on the 11th
  await flush();
  assert.deepEqual(h.rated, ["2026-03-10"]);
  h.scheduler.stop();
});

test("the noon cutoff: 11:59 rates yesterday, 12:00 rates today", async (t) => {
  for (const [time, day] of [
    ["11:59", "2026-03-09"],
    ["12:00", "2026-03-10"],
  ] as const) {
    t.mock.timers.reset();
    clockAt10(t);
    const h = harness();
    h.scheduler.setRatingTime(time);
    h.scheduler.start();
    t.mock.timers.tick(2 * HOUR + MIN);
    await flush();
    assert.deepEqual(h.rated, [day], time);
    h.scheduler.stop();
  }
});

test("a time changed while running is the one that decides the day", async (t) => {
  clockAt10(t);
  const h = harness();
  h.scheduler.start(); // armed for the 00:00 default
  h.scheduler.setRatingTime("22:00");
  t.mock.timers.tick(12 * HOUR);
  await flush();
  assert.deepEqual(h.rated, ["2026-03-10"]);
  h.scheduler.stop();
});

test("the rating switch is read at every firing, not once at start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const settings = new Map([["nightlyRating", "off"]]);
  const h = harness({}, undefined, settings);
  h.scheduler.start();
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.rated.length, 0);

  settings.set("nightlyRating", "on");
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.rated.length, 1);

  settings.set("nightlyRating", "off");
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(h.rated.length, 1);
  h.scheduler.stop();
});

test("a rating prompt that never resolves does not stop the next night's", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0;
  const scheduler = new Scheduler(
    {
      windowStats: async () => ({ total: 0 }),
      getSetting: async () => true,
    } as any,
    { retrySweep: async () => {} } as any,
    async () => {},
    () => {
      calls++;
      return new Promise<void>(() => {});
    },
    async () => {},
    async () => {},
    1000,
  );
  scheduler.start();
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(calls, 2);
  scheduler.stop();
});

test("a rating that throws does not hold back the habit review in the same tick", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const habits: string[] = [];
  const scheduler = new Scheduler(
    {
      windowStats: async () => ({ total: 0 }),
      getSetting: async () => true,
    } as any,
    { retrySweep: async () => {} } as any,
    async () => {},
    async () => {
      throw new Error("telegram is down");
    },
    async (d: string) => void habits.push(d),
    async () => {},
    1000,
  );
  scheduler.start();
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(habits.length, 1);
  scheduler.stop();
  t.mock.timers.tick(3 * DAY);
  await flush();
  assert.equal(habits.length, 1);
});

test("the daily summary stays quiet on a day with no jots", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness({ total: 0 });
  h.scheduler.start();
  t.mock.timers.tick(DAY);
  await flush();
  assert.deepEqual(h.notified, []);
});

test("the daily summary counts jots, and names failures only when there are some", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const clean = harness({ total: 4, audio: 1 });
  clean.scheduler.start();
  t.mock.timers.tick(DAY);
  await flush(8);
  assert.equal(clean.notified.length, 1);
  assert.match(clean.notified[0]!, /Jots: 4 \(voice: 1\)/);
  assert.ok(!clean.notified[0]!.includes("Failed"));
  clean.scheduler.stop();

  // failed and abandoned are one number to the reader: both mean "didn't land cleanly".
  const bad = harness({ total: 4, audio: 1, failed: 1, abandoned: 2 });
  bad.scheduler.start();
  t.mock.timers.tick(DAY);
  await flush(8);
  assert.match(bad.notified[0]!, /⚠️ Failed\/abandoned: 3/);
  bad.scheduler.stop();
});
