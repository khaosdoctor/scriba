import assert from "node:assert/strict";
import { test } from "node:test";
import { Scheduler } from "./scheduler.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Hand back to the event loop so the awaits inside a fired timer can settle. Mock timers
 *  move the clock, not the microtask queue. */
const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

/** A job that records each run under its name. */
function recorder() {
  const runs: string[] = [];
  const job = (name: string) => async () => void runs.push(name);
  return {
    runs,
    job,
    count: (name: string) => runs.filter((r) => r === name).length,
  };
}

/** Mock timers and the clock together, starting at 10:00 local on 2026-03-10. */
function clockAt10(t: { mock: { timers: { enable: (o: any) => void } } }) {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: new Date(2026, 2, 10, 10, 0).getTime(),
  });
}

test("an interval job runs on its interval and stops when the scheduler does", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const r = recorder();
  const scheduler = new Scheduler();
  scheduler.every("retry", 1000, r.job("retry"));
  await scheduler.start();

  // A tick at a time, letting each run settle: two firings inside one synchronous tick
  // would collapse into one, which is the overlap guard doing its job (see below).
  for (let i = 1; i <= 3; i++) {
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(r.count("retry"), i);
  }

  scheduler.stop();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(r.count("retry"), 3);
});

test("a slow run doesn't stack up behind itself", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let runs = 0;
  const scheduler = new Scheduler();
  scheduler.every("retry", 1000, async () => {
    runs++;
    await held;
  });
  await scheduler.start();

  // Three ticks while the first run is still going: the guard should hold them off, or a
  // run slower than the interval would pile stacks on the same pending jots.
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(runs, 1);

  release();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(runs, 2);
  scheduler.stop();
});

test("a run that throws is logged and the next one still runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let boom = true;
  let runs = 0;
  const scheduler = new Scheduler();
  scheduler.every("retry", 1000, async () => {
    runs++;
    if (boom) throw new Error("obsidian is down");
  });
  await scheduler.start();

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(runs, 1);
  // The guard is cleared even after a failure: without that one failure stops the job forever.
  boom = false;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(runs, 2);
  scheduler.stop();
});

test("a daily job fires every day, on its own schedule", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const r = recorder();
  const scheduler = new Scheduler();
  scheduler.daily("tasks", () => "09:00", r.job("tasks"));
  await scheduler.start();

  // Its time falls somewhere inside any 24h window, whatever "now" is.
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(r.count("tasks"), 1);

  // Re-armed, so it goes out every morning rather than once after a deploy.
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(r.count("tasks"), 2);

  scheduler.stop();
  t.mock.timers.tick(DAY * 2);
  await flush();
  assert.equal(r.count("tasks"), 2);
});

test("daily jobs fire at their time, then re-arm", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const r = recorder();
  const scheduler = new Scheduler();
  scheduler.daily("rating", () => "00:00", r.job("rating"), {
    armBeforeRun: true,
  });
  scheduler.daily("habits", () => "00:00", r.job("habits"));
  await scheduler.start();

  // Both are at 00:00, so a full day's tick reaches them whatever "now" is.
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(r.count("rating"), 1);
  assert.equal(r.count("habits"), 1);

  // Re-armed for tomorrow rather than firing once and going quiet.
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(r.count("rating"), 2);
  assert.equal(r.count("habits"), 2);
  scheduler.stop();
});

test("changing a daily job's time re-arms it, and only the new time fires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const r = recorder();
  let at = "23:59";
  const scheduler = new Scheduler();
  scheduler.daily("rating", () => at, r.job("rating"), { armBeforeRun: true });
  await scheduler.rearm("rating");
  await scheduler.start();
  // Move it while running: only the new time fires, once per day.
  at = "22:00";
  await scheduler.rearm("rating");
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(r.count("rating"), 1);
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(r.count("rating"), 2);
  scheduler.stop();
});

test("a daily job that throws still re-arms for tomorrow", async (t) => {
  for (const armBeforeRun of [false, true]) {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let calls = 0;
    const scheduler = new Scheduler();
    scheduler.daily(
      "prompt",
      () => "00:00",
      async () => {
        calls++;
        throw new Error("telegram is down");
      },
      { armBeforeRun },
    );
    await scheduler.start();

    t.mock.timers.tick(DAY);
    await flush();
    assert.equal(calls, 1, `armBeforeRun ${armBeforeRun}`);
    t.mock.timers.tick(DAY);
    await flush();
    assert.equal(calls, 2, `armBeforeRun ${armBeforeRun}`);
    scheduler.stop();
    t.mock.timers.reset();
  }
});

test("a stopped scheduler never fires a daily job", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const r = recorder();
  const scheduler = new Scheduler();
  scheduler.daily("rating", () => "00:00", r.job("rating"), {
    armBeforeRun: true,
  });
  scheduler.daily("habits", () => "00:00", r.job("habits"));
  await scheduler.start();
  scheduler.stop();
  t.mock.timers.tick(3 * DAY);
  await flush();
  assert.deepEqual(r.runs, []);
});

test("a time rearmed before start only records it, and the first firing uses it", async (t) => {
  clockAt10(t);
  const r = recorder();
  const scheduler = new Scheduler();
  scheduler.daily("rating", () => "22:00", r.job("rating"));
  await scheduler.rearm("rating");
  t.mock.timers.tick(3 * DAY);
  await flush();
  assert.equal(r.count("rating"), 0);

  // Fresh clock: the tick above moved it.
  t.mock.timers.reset();
  clockAt10(t);
  await scheduler.start();
  t.mock.timers.tick(11 * HOUR + 59 * MIN);
  await flush();
  assert.equal(r.count("rating"), 0);
  t.mock.timers.tick(MIN);
  await flush();
  assert.equal(r.count("rating"), 1);
  scheduler.stop();
});

test("changing the time again and again leaves one timer, at the last time", async (t) => {
  clockAt10(t);
  const r = recorder();
  let at = "00:00";
  const scheduler = new Scheduler();
  scheduler.daily("rating", () => at, r.job("rating"), { armBeforeRun: true });
  await scheduler.start();
  for (at of ["12:00", "13:00", "13:00"]) await scheduler.rearm("rating");
  t.mock.timers.tick(2 * HOUR + 30 * MIN); // 12:30, past the abandoned 12:00
  await flush();
  assert.deepEqual(r.runs, []);
  t.mock.timers.tick(30 * MIN); // 13:00
  await flush();
  assert.deepEqual(r.runs, ["rating"]);
  scheduler.stop();
});

test("a time changed while running is the one that decides when it fires", async (t) => {
  clockAt10(t);
  const r = recorder();
  let at = "00:00";
  const scheduler = new Scheduler();
  scheduler.daily("rating", () => at, r.job("rating"), { armBeforeRun: true });
  await scheduler.start(); // armed for 00:00
  at = "22:00";
  await scheduler.rearm("rating");
  t.mock.timers.tick(12 * HOUR);
  await flush();
  assert.equal(r.count("rating"), 1);
  scheduler.stop();
});

test("a job that never resolves does not stop the next day's when it arms first", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0;
  const scheduler = new Scheduler();
  scheduler.daily(
    "rating",
    () => "00:00",
    () => {
      calls++;
      return new Promise<void>(() => {});
    },
    { armBeforeRun: true },
  );
  await scheduler.start();
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(calls, 2);
  scheduler.stop();
});

test("a daily job that throws does not hold back another in the same tick", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const r = recorder();
  const scheduler = new Scheduler();
  scheduler.daily(
    "rating",
    () => "00:00",
    async () => {
      throw new Error("telegram is down");
    },
    { armBeforeRun: true },
  );
  scheduler.daily("habits", () => "00:00", r.job("habits"));
  await scheduler.start();
  t.mock.timers.tick(DAY);
  await flush();
  assert.equal(r.count("habits"), 1);
  scheduler.stop();
  t.mock.timers.tick(3 * DAY);
  await flush();
  assert.equal(r.count("habits"), 1);
});
