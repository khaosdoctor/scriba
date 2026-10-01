import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { testConfig } from "../test/config.ts";
import { FakeSettings } from "../test/fakes.ts";
import { RatingCommand } from "./rating.ts";

const DATE = "2026-07-05";

/** A command whose collaborators only record what they were asked to do, in order. */
function harness(
  over: { recorded?: boolean; setFails?: boolean; startFails?: boolean } = {},
) {
  const events: string[] = [];
  const repo = {
    recordRating: async () => ({
      recorded: over.recorded ?? true,
      current: over.recorded === false ? 8 : 7,
    }),
    clearRating: async (date: string) => void events.push(`clear:${date}`),
  };
  const obsidian = {
    setDailyRating: async (date: string, n: number) => {
      if (over.setFails) throw new Error("vault 500");
      events.push(`save:${date}:${n}`);
    },
  };
  const followup = {
    start: async (date: string) => {
      events.push(`followup:${date}`);
      if (over.startFails) throw new Error("telegram down");
    },
  };
  const rating: any = new RatingCommand(
    {} as any,
    testConfig,
    repo as any,
    obsidian as any,
    followup as any,
  );
  const ctx = {
    answerCallbackQuery: async (a?: { text: string }) =>
      void events.push(`answer:${a?.text}`),
    editMessageText: async (t: string) => void events.push(`edit:${t}`),
  };
  return { rating, ctx, events };
}

test("a saved rating is confirmed to the user, then the follow-up starts for that day", async () => {
  const h = harness();
  await h.rating.handleTap(h.ctx, DATE, "7");
  assert.deepEqual(h.events, [
    `save:${DATE}:7`,
    "answer:saved 7/10",
    `edit:📊 ${DATE} rated 7/10`,
    `followup:${DATE}`,
  ]);
});

test("a follow-up that fails to start does not undo or fail the rating", async () => {
  const h = harness({ startFails: true });
  await h.rating.handleTap(h.ctx, DATE, "7");
  assert.deepEqual(h.events, [
    `save:${DATE}:7`,
    "answer:saved 7/10",
    `edit:📊 ${DATE} rated 7/10`,
    `followup:${DATE}`,
  ]);
});

test("a day that is already rated is not asked about again", async () => {
  const h = harness({ recorded: false });
  await h.rating.handleTap(h.ctx, DATE, "3");
  assert.deepEqual(h.events, [
    "answer:already rated 8/10",
    `edit:📊 ${DATE} already rated 8/10.`,
  ]);
});

test("a rating that fails to save is released and starts no follow-up", async () => {
  const h = harness({ setFails: true });
  await assert.rejects(h.rating.handleTap(h.ctx, DATE, "7"), /vault 500/);
  assert.deepEqual(h.events, [`clear:${DATE}`]);
});

test("a bad payload is refused before anything is recorded", async () => {
  for (const [date, n] of [
    [undefined, "7"],
    ["not-a-date", "7"],
    [DATE, "0"],
    [DATE, "11"],
    [DATE, "x"],
    [DATE, undefined],
  ] as const) {
    const h = harness();
    await h.rating.handleTap(h.ctx, date, n);
    assert.deepEqual(h.events, ["answer:bad rating"], `${date} ${n}`);
  }
});

test("/rate prompts for the day given, and refuses a malformed date with the usage line", async () => {
  const sent: { text: string; opts: any }[] = [];
  const handlers = new Map<string, (ctx: unknown) => Promise<unknown>>();
  const bot = {
    command: (name: string, handler: (ctx: unknown) => Promise<unknown>) =>
      void handlers.set(name, handler),
    api: {
      sendMessage: async (_chat: unknown, text: string, opts: any) =>
        void sent.push({ text, opts }),
    },
  };
  const rating: any = new RatingCommand(
    bot as any,
    testConfig,
    {} as any,
    {} as any,
    {} as any,
  );
  rating.register();
  const rate = handlers.get("rate");
  assert.ok(rate);

  const replies: string[] = [];
  const ctx = (match: string) => ({
    match,
    reply: async (t: string) => void replies.push(t),
  });
  await rate(ctx("tomorrow"));
  assert.deepEqual(replies, ["Usage: /rate or /rate YYYY-MM-DD"]);
  assert.equal(sent.length, 0);

  await rate(ctx(` ${DATE} `));
  assert.equal(sent[0]?.text, `📊 How was ${DATE}? Rate it 1–10:`);
  const rows: { callback_data: string }[][] =
    sent[0]?.opts.reply_markup.inline_keyboard;
  assert.deepEqual(
    rows.map((row) => row.map((b) => b.callback_data)),
    [
      [1, 2, 3, 4, 5].map((n) => `rate:${DATE}:${n}`),
      [6, 7, 8, 9, 10].map((n) => `rate:${DATE}:${n}`),
    ],
  );

  await rate(ctx(""));
  assert.match(sent[1]?.text ?? "", /^📊 How was \d{4}-\d{2}-\d{2}\?/);
});

/** A command whose repository holds `stored` settings; `sent` collects the prompt texts. */
function nightlyHarness(stored: Record<string, string> = {}) {
  const sent: string[] = [];
  const bot = {
    api: {
      sendMessage: async (_chat: unknown, text: string) => void sent.push(text),
    },
  };
  const settings = new Map(Object.entries(stored));
  const rating: any = new RatingCommand(
    bot as any,
    testConfig,
    new FakeSettings(settings) as any,
    {} as any,
    {} as any,
  );
  return { rating, sent, settings };
}

const promptFor = (date: string) => `📊 How was ${date}? Rate it 1–10:`;

/** The clock at a local time on 2026-03-10 (or the 11th), for the day a prompt is about. */
function clockAt(t: TestContext, hour: number, minute = 0, day = 10) {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 2, day, hour, minute).getTime(),
  });
}

test("the nightly rating is read at every firing, so its switch needs no restart", async (t) => {
  clockAt(t, 12, 1);
  const h = nightlyHarness({ nightlyRating: "off", ratingTime: "12:00" });
  await h.rating.nightly();
  assert.deepEqual(h.sent, []);

  h.settings.set("nightlyRating", "on");
  await h.rating.nightly();
  assert.deepEqual(h.sent, [promptFor("2026-03-10")]);

  h.settings.set("nightlyRating", "off");
  await h.rating.nightly();
  assert.equal(h.sent.length, 1);
});

test("a midnight rating is for the day that just ended, by exact date", async (t) => {
  clockAt(t, 0, 0, 11);
  const h = nightlyHarness({ ratingTime: "00:00" });
  await h.rating.nightly();
  assert.deepEqual(h.sent, [promptFor("2026-03-10")]);
});

test("the noon cutoff: 11:59 rates yesterday, 12:00 rates today, and the stored time decides", async (t) => {
  for (const [time, day] of [
    ["11:59", "2026-03-09"],
    ["12:00", "2026-03-10"],
    ["22:00", "2026-03-10"],
  ] as const) {
    clockAt(t, 12, 1);
    const h = nightlyHarness({ ratingTime: time });
    await h.rating.nightly();
    assert.deepEqual(h.sent, [promptFor(day)], time);
    t.mock.timers.reset();
  }
});
