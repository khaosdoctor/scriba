import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { FakeSettings } from "../test/fakes.ts";
import {
  followupFromCode,
  followupQuestions,
  followupRef,
  RatingService,
} from "./rating.ts";

const DATE = "2026-07-05";
const EMPTY = "## Journal\n-\n## TIL\n-\n";
const JOTTED = "## Journal\n- _10:00:00 ::_ hi ^aaaaaaaa\n## TIL\n-\n";
const HEADINGS = { journal: "Journal", til: "TIL" };

const DAILY_TEMPLATE = `---
tags:
  - type/daily-note
overallRating: 5
---
# 2026-07-05
---
## ✅ Tasks
\`\`\`tasks
preset on_or_before_this_file_name
\`\`\`
## Journal
-
## Habits
- [ ] Practiced music #meta/habits/music
## TIL
-
## Log
- [Health log](obsidian://open)
`;

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
    setDailyRating: async (date: string, n: number) => {
      if (over.setFails) throw new Error("vault 500");
      events.push(`save:${date}:${n}`);
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
    repo,
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
  const h = setup();
  assert.deepEqual(await h.rating.rate(DATE, 7), { kind: "saved", rating: 7 });
  assert.deepEqual(h.events, [`save:${DATE}:7`]);
});

test("a day that is already rated is reported with its rating and not written again", async () => {
  const h = setup({ recorded: false });
  assert.deepEqual(await h.rating.rate(DATE, 3), {
    kind: "already",
    current: 8,
  });
  assert.deepEqual(h.events, []);
});

test("a rating that fails to save is released so the tap can be retried", async () => {
  const h = setup({ setFails: true });
  await assert.rejects(h.rating.rate(DATE, 7), /vault 500/);
  assert.deepEqual(h.events, [`clear:${DATE}`]);
});

/** The clock at a local time on 2026-03-10 (or the 11th), for the day a prompt is about. */
function clockAt(t: TestContext, hour: number, minute = 0, day = 10) {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 2, day, hour, minute).getTime(),
  });
}

test("the nightly rating is read at every firing, so its switch needs no restart", async (t) => {
  clockAt(t, 12, 1);
  const stored = new Map([
    ["nightlyRating", "off"],
    ["ratingTime", "12:00"],
  ]);
  const sent: string[] = [];
  const rating = new RatingService({
    repo: new FakeSettings(stored),
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

test("a midnight rating is for the day that just ended, by exact date", async (t) => {
  clockAt(t, 0, 0, 11);
  const h = setup({ settings: { ratingTime: "00:00" } });
  await h.rating.nightly();
  assert.deepEqual(
    h.sent.map((s) => s.text),
    [promptFor("2026-03-10")],
  );
});

test("the noon cutoff: 11:59 rates yesterday, 12:00 rates today, and the stored time decides", async (t) => {
  for (const [time, day] of [
    ["11:59", "2026-03-09"],
    ["12:00", "2026-03-10"],
    ["22:00", "2026-03-10"],
  ] as const) {
    clockAt(t, 12, 1);
    const h = setup({ settings: { ratingTime: time } });
    await h.rating.nightly();
    assert.deepEqual(
      h.sent.map((s) => s.text),
      [promptFor(day)],
      time,
    );
    t.mock.timers.reset();
  }
});

// --- which question to ask ---

test("followupQuestions asks only what is still empty", () => {
  const jot = "- _10:00:00 ::_ hi ^aaaaaaaa";
  const til = "- a thing I learned";
  const withJournal = DAILY_TEMPLATE.replace(
    "## Journal\n-\n",
    `## Journal\n${jot}\n`,
  );
  const withTil = DAILY_TEMPLATE.replace("## TIL\n-\n", `## TIL\n${til}\n`);
  const withBoth = withJournal.replace("## TIL\n-\n", `## TIL\n${til}\n`);
  assert.deepEqual(followupQuestions(DAILY_TEMPLATE, HEADINGS), [
    "journal",
    "til",
  ]);
  assert.deepEqual(followupQuestions(withJournal, HEADINGS), ["til"]);
  assert.deepEqual(followupQuestions(withTil, HEADINGS), ["journal"]);
  assert.deepEqual(followupQuestions(withBoth, HEADINGS), []);
});

test("followupQuestions asks both for a day with no note, and resumes after a question", () => {
  assert.deepEqual(followupQuestions(null, HEADINGS), ["journal", "til"]);
  assert.deepEqual(followupQuestions(null, HEADINGS, "journal"), ["til"]);
  assert.deepEqual(followupQuestions(null, HEADINGS, "til"), []);
});

test("followupQuestions follows the configured headings", () => {
  const note = "## Journal\n- \n## Learned\n- something\n";
  assert.deepEqual(
    followupQuestions(note, { journal: "Journal", til: "Learned" }),
    ["journal"],
  );
});

test("followupQuestions counts a missing section as empty", () => {
  assert.deepEqual(followupQuestions("## Journal\n- a\n", HEADINGS), ["til"]);
  assert.deepEqual(followupQuestions("## TIL\n- a\n", HEADINGS), ["journal"]);
  assert.deepEqual(followupQuestions("# 2026-07-05\n", HEADINGS), [
    "journal",
    "til",
  ]);
});

// --- asking ---

test("start asks the journal question first on an empty note, with a Skip button", async () => {
  const h = setup();
  await h.rating.startFollowup(DATE);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.text, /One line for the day\?/);
  assert.match(h.sent[0]!.text, /\(fu:j:2026-07-05\)/);
  const button = h.sent[0]!.opts.keyboard.inline_keyboard[0][0];
  assert.match(button.text, /Skip/);
  assert.equal(button.callback_data, `fu:j:${DATE}`);
});

test("start asks only the TIL question when the journal has jots", async () => {
  const h = setup({ notes: [JOTTED] });
  await h.rating.startFollowup(DATE);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.text, /Learned anything today\?/);
});

test("start asks nothing when both sections are filled", async () => {
  const h = setup({ notes: ["## Journal\n- a\n## TIL\n- b\n"] });
  await h.rating.startFollowup(DATE);
  assert.deepEqual(h.sent, []);
});

test("start asks both for a day with no note", async () => {
  const h = setup({ notes: [null] });
  await h.rating.startFollowup(DATE);
  assert.match(h.sent[0]!.text, /One line for the day\?/);
});

test("start stays quiet while the follow-up switch is off", async () => {
  const h = setup({ settings: { nightlyFollowup: "off" } });
  await h.rating.startFollowup(DATE);
  assert.deepEqual(h.sent, []);
});

test("the rating switch does not stop a follow-up that follows a manual rating", async () => {
  // The rating switch governs the nightly prompt only, so a rating you asked for yourself
  // still leads into the follow-up.
  const h = setup({ settings: { nightlyRating: "off" } });
  await h.rating.startFollowup(DATE);
  assert.equal(h.sent.length, 1);
});

test("start reads the follow-up switch and never the rating's", async () => {
  const h = setup();
  await h.rating.startFollowup(DATE);
  assert.deepEqual(h.reads, ["nightlyFollowup"]);
});

test("a prompt's text and Skip payload route back to the same question and day", async () => {
  for (const [notes, code] of [
    [[EMPTY], "j"],
    [[JOTTED], "t"],
  ] as const) {
    const h = setup({ notes: [...notes] });
    await h.rating.startFollowup(DATE);
    const { text, opts } = h.sent[0]!;
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
  const h = setup();
  const sink = jotSink();
  await h.rating.answerFollowup(
    { question: "journal", date: DATE },
    "Quiet day, read a lot",
    5,
    sink.jot,
  );
  assert.deepEqual(sink.jots, [[DATE, "Quiet day, read a lot"]]);
  assert.deepEqual(h.deleted, [5]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.text, /Learned anything today\?/);
});

test("a TIL answer is sent as a TIL-prefixed jot and ends the flow", async () => {
  const h = setup();
  const sink = jotSink();
  await h.rating.answerFollowup(
    { question: "til", date: DATE },
    "owls can't move their eyes",
    5,
    sink.jot,
  );
  assert.deepEqual(sink.jots, [[DATE, "TIL: owls can't move their eyes"]]);
  assert.deepEqual(h.deleted, [5]);
  assert.deepEqual(h.sent, []);
});

test("a journal answer skips the TIL question when the TIL is already filled", async () => {
  const h = setup({ notes: ["## Journal\n-\n## TIL\n- known\n"] });
  await h.rating.answerFollowup(
    { question: "journal", date: DATE },
    "ok",
    5,
    jotSink().jot,
  );
  assert.deepEqual(h.sent, []);
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
    const h = setup({ notes: [JOTTED] });
    const sink = jotSink();
    await h.rating.answerFollowup(
      { question: question as "journal" | "til", date: DATE },
      text,
      5,
      sink.jot,
    );
    assert.deepEqual(sink.jots, [[DATE, filed]], text.slice(0, 20));
  }
});

test("a failed intake keeps the prompt and asks nothing more", async () => {
  const h = setup();
  await assert.rejects(
    h.rating.answerFollowup(
      { question: "journal", date: DATE },
      "ok",
      5,
      jotSink(true).jot,
    ),
    /intake failed/,
  );
  assert.deepEqual(h.deleted, []);
  assert.deepEqual(h.sent, []);
});

test("a prompt Telegram won't delete does not stop a reply from asking the next question", async () => {
  const h = setup({ deleteFails: true });
  const sink = jotSink();
  await h.rating.answerFollowup(
    { question: "journal", date: DATE },
    "ok",
    5,
    sink.jot,
  );
  assert.deepEqual(sink.jots, [[DATE, "ok"]]);
  assert.match(h.sent[0]!.text, /Learned anything today\?/);
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
