import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { followupFromCode, followupRef } from "../libs/followup.ts";
import { FakeSettings } from "../test/fakes.ts";
import { RatingService } from "./rating.ts";

const DATE = "2026-07-05";
const EMPTY = "## Journal\n-\n## TIL\n-\n";
const JOTTED = "## Journal\n- _10:00:00 ::_ hi ^aaaaaaaa\n## TIL\n-\n";
const HEADINGS = { journal: "Journal", til: "TIL" };

type Sent = { text: string; opts: any };

/** A controller whose collaborators only record what they were asked to do, in order.
 *  `notes` is what the day's note reads as on each successive read, the last one repeating. */
function setup(
  over: {
    settings?: Record<string, string>;
    notes?: (string | null)[];
    recorded?: boolean;
    setFails?: boolean;
    deleteFails?: boolean;
  } = {},
) {
  const events: string[] = [];
  const sent: Sent[] = [];
  const deleted: number[] = [];
  const settings = new FakeSettings(over.settings);
  const notes = over.notes ?? [EMPTY];
  let reads = 0;
  const repo = {
    ...settings,
    recordRating: async () => ({
      recorded: over.recorded ?? true,
      current: over.recorded === false ? 8 : 7,
    }),
    clearRating: async (date: string) => void events.push(`clear:${date}`),
  };
  const obsidian = {
    setDailyRating: async (date: string, rating: number) => {
      if (over.setFails) throw new Error("vault 500");
      events.push(`save:${date}:${rating}`);
    },
    readDailyNote: async () => {
      const note = notes[Math.min(reads++, notes.length - 1)];
      return note === null ? null : { path: "p", content: note };
    },
  };
  const notifier = {
    send: async (text: string, opts: any) => {
      sent.push({ text, opts });
      return 900 + sent.length;
    },
    delete: async (id: number) => {
      deleted.push(id);
      if (over.deleteFails) throw new Error("message to delete not found");
    },
  };
  const rating = new RatingService({
    settings: repo,
    ratings: repo,
    obsidian,
    notifier,
    ratingTime: "22:00",
    headings: HEADINGS,
  } as never);
  return { rating, events, sent, deleted, reads: settings.reads };
}

const promptFor = (date: string) => `📊 How was ${date}? Rate it 1–10:`;

// --- rating ---

test("a rating is written to the day's note and reported as saved", async () => {
  const harness = setup();
  assert.deepEqual(await harness.rating.rate(DATE, 7), {
    kind: "saved",
    rating: 7,
  });
  assert.deepEqual(harness.events, [`save:${DATE}:7`]);
});

test("a day that is already rated is reported with its rating and not written again", async () => {
  const harness = setup({ recorded: false });
  assert.deepEqual(await harness.rating.rate(DATE, 3), {
    kind: "already",
    current: 8,
  });
  assert.deepEqual(harness.events, []);
});

test("a rating that fails to save is released so the tap can be retried", async () => {
  const harness = setup({ setFails: true });
  await assert.rejects(harness.rating.rate(DATE, 7), /vault 500/);
  assert.deepEqual(harness.events, [`clear:${DATE}`]);
});

/** The clock at a local time on 2026-03-10 (or the 11th), for the day a prompt is about. */
function clockAt(context: TestContext, hour: number, minute = 0, day = 10) {
  context.mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 2, day, hour, minute).getTime(),
  });
}

test("the nightly rating is read at every firing, so its switch needs no restart", async (context) => {
  clockAt(context, 12, 1);
  const stored = new Map([
    ["nightlyRating", "off"],
    ["ratingTime", "12:00"],
  ]);
  const sent: string[] = [];
  const rating = new RatingService({
    settings: new FakeSettings(stored),
    notifier: { send: async (text: string) => void sent.push(text) },
    ratingTime: "22:00",
  } as never);
  await rating.nightly();
  assert.deepEqual(sent, []);

  stored.set("nightlyRating", "on");
  await rating.nightly();
  assert.deepEqual(sent, [promptFor("2026-03-10")]);

  stored.set("nightlyRating", "off");
  await rating.nightly();
  assert.equal(sent.length, 1);
});

test("a midnight rating is for the day that just ended, by exact date", async (context) => {
  clockAt(context, 0, 0, 11);
  const harness = setup({ settings: { ratingTime: "00:00" } });
  await harness.rating.nightly();
  assert.deepEqual(
    harness.sent.map((message) => message.text),
    [promptFor("2026-03-10")],
  );
});

test("the noon cutoff: 11:59 rates yesterday, 12:00 rates today, and the stored time decides", async (context) => {
  for (const [time, day] of [
    ["11:59", "2026-03-09"],
    ["12:00", "2026-03-10"],
    ["22:00", "2026-03-10"],
  ] as const) {
    clockAt(context, 12, 1);
    const harness = setup({ settings: { ratingTime: time } });
    await harness.rating.nightly();
    assert.deepEqual(
      harness.sent.map((message) => message.text),
      [promptFor(day)],
      time,
    );
    context.mock.timers.reset();
  }
});

// --- asking ---

test("start asks the journal question first on an empty note, with a Skip button", async () => {
  const harness = setup();
  await harness.rating.startFollowup(DATE);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0]!.text, /One line for the day\?/);
  assert.match(harness.sent[0]!.text, /\(fu:j:2026-07-05\)/);
  const button = harness.sent[0]!.opts.keyboard.inline_keyboard[0][0];
  assert.match(button.text, /Skip/);
  assert.equal(button.callback_data, `fu:j:${DATE}`);
});

test("start asks only the TIL question when the journal has jots", async () => {
  const harness = setup({ notes: [JOTTED] });
  await harness.rating.startFollowup(DATE);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0]!.text, /Learned anything today\?/);
});

test("start asks nothing when both sections are filled", async () => {
  const harness = setup({ notes: ["## Journal\n- a\n## TIL\n- b\n"] });
  await harness.rating.startFollowup(DATE);
  assert.deepEqual(harness.sent, []);
});

test("start asks both for a day with no note", async () => {
  const harness = setup({ notes: [null] });
  await harness.rating.startFollowup(DATE);
  assert.match(harness.sent[0]!.text, /One line for the day\?/);
});

test("start stays quiet while the follow-up switch is off", async () => {
  const harness = setup({ settings: { nightlyFollowup: "off" } });
  await harness.rating.startFollowup(DATE);
  assert.deepEqual(harness.sent, []);
});

test("the rating switch does not stop a follow-up that follows a manual rating", async () => {
  // The rating switch governs the nightly prompt only, so a rating you asked for yourself
  // still leads into the follow-up.
  const harness = setup({ settings: { nightlyRating: "off" } });
  await harness.rating.startFollowup(DATE);
  assert.equal(harness.sent.length, 1);
});

test("start reads the follow-up switch and never the rating's", async () => {
  const harness = setup();
  await harness.rating.startFollowup(DATE);
  assert.deepEqual(harness.reads, ["nightlyFollowup"]);
});

test("a prompt's text and Skip payload route back to the same question and day", async () => {
  for (const [notes, code] of [
    [[EMPTY], "j"],
    [[JOTTED], "t"],
  ] as const) {
    const harness = setup({ notes: [...notes] });
    await harness.rating.startFollowup(DATE);
    const { text, opts } = harness.sent[0]!;
    const question = followupFromCode(code);
    assert.ok(question);
    assert.ok(text.length < 200);
    assert.ok(text.endsWith(followupRef(question, DATE)));
    assert.equal(
      opts.keyboard.inline_keyboard[0][0].callback_data,
      `fu:${code}:${DATE}`,
    );
  }
});

// --- answering ---

/** Collects the jots an answer files, as the reply view would pass them to intake. */
function jotSink(fails = false) {
  const jots: [string, string][] = [];
  const jot = async (date: string, text: string) => {
    if (fails) throw new Error("intake failed");
    jots.push([date, text]);
  };
  return { jots, jot };
}

test("a journal answer becomes a jot for the rated day, drops the prompt and asks the TIL", async () => {
  const harness = setup();
  const sink = jotSink();
  await harness.rating.answerFollowup(
    { question: "journal", date: DATE },
    "Quiet day, read a lot",
    5,
    sink.jot,
  );
  assert.deepEqual(sink.jots, [[DATE, "Quiet day, read a lot"]]);
  assert.deepEqual(harness.deleted, [5]);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0]!.text, /Learned anything today\?/);
});

test("a TIL answer is sent as a TIL-prefixed jot and ends the flow", async () => {
  const harness = setup();
  const sink = jotSink();
  await harness.rating.answerFollowup(
    { question: "til", date: DATE },
    "owls can't move their eyes",
    5,
    sink.jot,
  );
  assert.deepEqual(sink.jots, [[DATE, "TIL: owls can't move their eyes"]]);
  assert.deepEqual(harness.deleted, [5]);
  assert.deepEqual(harness.sent, []);
});

test("a journal answer skips the TIL question when the TIL is already filled", async () => {
  const harness = setup({ notes: ["## Journal\n-\n## TIL\n- known\n"] });
  await harness.rating.answerFollowup(
    { question: "journal", date: DATE },
    "ok",
    5,
    jotSink().jot,
  );
  assert.deepEqual(harness.sent, []);
});

test("the controller adds nothing to an answer beyond the TIL prefix", async () => {
  const long = "x".repeat(5000);
  const cases: [string, string, string][] = [
    ["journal", "😴 slept 10h ☕", "😴 slept 10h ☕"],
    ["journal", "line1\r\nline2", "line1\r\nline2"],
    ["journal", long, long],
    ["til", "TIL: x", "TIL: TIL: x"],
    ["journal", "til noon I slept", "til noon I slept"],
  ];
  for (const [question, text, filed] of cases) {
    const harness = setup({ notes: [JOTTED] });
    const sink = jotSink();
    await harness.rating.answerFollowup(
      { question: question as "journal" | "til", date: DATE },
      text,
      5,
      sink.jot,
    );
    assert.deepEqual(sink.jots, [[DATE, filed]], text.slice(0, 20));
  }
});

test("a failed intake keeps the prompt and asks nothing more", async () => {
  const harness = setup();
  await assert.rejects(
    harness.rating.answerFollowup(
      { question: "journal", date: DATE },
      "ok",
      5,
      jotSink(true).jot,
    ),
    /intake failed/,
  );
  assert.deepEqual(harness.deleted, []);
  assert.deepEqual(harness.sent, []);
});

test("a prompt Telegram won't delete does not stop a reply from asking the next question", async () => {
  const harness = setup({ deleteFails: true });
  const sink = jotSink();
  await harness.rating.answerFollowup(
    { question: "journal", date: DATE },
    "ok",
    5,
    sink.jot,
  );
  assert.deepEqual(sink.jots, [[DATE, "ok"]]);
  assert.match(harness.sent[0]!.text, /Learned anything today\?/);
});

test("the next question is read from the note after the answer, and only looks forward", async () => {
  const afterJournal = setup({ notes: ["## Journal\n- a\n## TIL\n- b\n"] });
  await afterJournal.rating.answerFollowup(
    { question: "journal", date: DATE },
    "x",
    5,
    jotSink().jot,
  );
  assert.deepEqual(afterJournal.sent, []);

  // The journal jot was undone meanwhile: answering the TIL must not go back to it.
  const afterTil = setup();
  await afterTil.rating.answerFollowup(
    { question: "til", date: DATE },
    "x",
    5,
    jotSink().jot,
  );
  assert.deepEqual(afterTil.sent, []);
});

test("a fresh controller answers a prompt sent by another, so no state is shared", async () => {
  const first = setup();
  await first.rating.startFollowup(DATE);
  const ref = first.sent[0]!.text.match(/\(fu:([jt]):(\d{4}-\d{2}-\d{2})\)/);
  const question = followupFromCode(ref?.[1]);
  assert.ok(question && ref?.[2]);

  const second = setup();
  const sink = jotSink();
  await second.rating.answerFollowup(
    { question, date: ref[2] },
    "Quiet",
    5,
    sink.jot,
  );
  assert.deepEqual(sink.jots, [[DATE, "Quiet"]]);
  assert.match(second.sent[0]!.text, /Learned anything today\?/);
});

// --- skipping ---

test("Skip on a stale prompt asks from the note as it is now", async () => {
  const done = setup({ notes: ["## Journal\n- a\n## TIL\n- b\n"] });
  await done.rating.skipFollowup("journal", DATE, 9);
  assert.deepEqual(done.sent, []);

  const tilOnly = setup({ notes: [JOTTED] });
  await tilOnly.rating.skipFollowup("journal", DATE, 9);
  assert.match(tilOnly.sent[0]!.text, /Learned anything today\?/);

  const old = setup();
  await old.rating.skipFollowup("journal", "2026-06-25", 9);
  assert.match(old.sent[0]!.text, /\(fu:t:2026-06-25\)/);
});
