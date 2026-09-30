import assert from "node:assert/strict";
import { test } from "node:test";

// followup.ts pulls in config.ts, which validates process.env at import time, so give it the
// bare minimum first (the same trick scheduler.test.ts uses).
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { FollowupFlow } = await import("./followup.ts");

const DATE = "2026-07-05";
const EMPTY = "## Journal\n-\n## TIL\n-\n";
const JOTTED = "## Journal\n- _10:00:00 ::_ hi ^aaaaaaaa\n## TIL\n-\n";

/** A flow whose collaborators only record what they were asked to do. `notes` is what the
 *  day's note reads as on each successive read, the last one repeating. */
function harness(
  settings: Record<string, string> = {},
  notes: (string | null)[] = [EMPTY],
) {
  const sent: { text: string; opts: any }[] = [];
  const deleted: [number, number][] = [];
  const jots: [string, string][] = [];
  let reads = 0;
  const bot = {
    api: {
      sendMessage: async (_chat: number, text: string, opts: any) =>
        void sent.push({ text, opts }),
      deleteMessage: async (chat: number, id: number) =>
        void deleted.push([chat, id]),
    },
  };
  const repo = { getSetting: async (key: string) => settings[key] };
  const obsidian = {
    readDailyNote: async () => {
      const note = notes[Math.min(reads++, notes.length - 1)];
      return note === null ? null : { path: "p", content: note };
    },
  };
  const flow = new FollowupFlow(
    bot as any,
    repo as any,
    obsidian as any,
    async (_ctx, date, text) => void jots.push([date, text]),
  );
  return { flow, sent, deleted, jots };
}

const reply = (text: string, promptId = 5) => ({
  chat: { id: 1 },
  message: { text, reply_to_message: { message_id: promptId } },
});

const tap = () => {
  const answers: any[] = [];
  return {
    answers,
    ctx: {
      chat: { id: 1 },
      callbackQuery: { message: { message_id: 9 } },
      answerCallbackQuery: async (a?: any) => void answers.push(a),
    },
  };
};

test("start asks the journal question first on an empty note, with a Skip button", async () => {
  const h = harness();
  await h.flow.start(DATE);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.text, /One line for the day\?/);
  assert.match(h.sent[0]!.text, /\(fu:j:2026-07-05\)/);
  const button = h.sent[0]!.opts.reply_markup.inline_keyboard[0][0];
  assert.match(button.text, /Skip/);
  assert.equal(button.callback_data, `fu:j:${DATE}`);
});

test("start asks only the TIL question when the journal has jots", async () => {
  const h = harness({}, [JOTTED]);
  await h.flow.start(DATE);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.text, /Learned anything today\?/);
});

test("start asks nothing when both sections are filled", async () => {
  const h = harness({}, ["## Journal\n- a\n## TIL\n- b\n"]);
  await h.flow.start(DATE);
  assert.deepEqual(h.sent, []);
});

test("start asks both for a day with no note", async () => {
  const h = harness({}, [null]);
  await h.flow.start(DATE);
  assert.match(h.sent[0]!.text, /One line for the day\?/);
});

test("start stays quiet while the follow-up switch is off", async () => {
  const h = harness({ nightlyFollowup: "off" });
  await h.flow.start(DATE);
  assert.deepEqual(h.sent, []);
});

test("the rating switch does not stop a follow-up that follows a manual rating", async () => {
  // The rating switch governs the nightly prompt only (the scheduler reads it), so a rating
  // you asked for yourself still leads into the follow-up.
  const h = harness({ nightlyRating: "off" });
  await h.flow.start(DATE);
  assert.equal(h.sent.length, 1);
});

test("a journal answer becomes a jot for the rated day, drops the prompt and asks the TIL", async () => {
  const h = harness({}, [EMPTY]);
  await h.flow.handleReply(reply("Quiet day, read a lot"), {
    question: "journal",
    date: DATE,
  });
  assert.deepEqual(h.jots, [[DATE, "Quiet day, read a lot"]]);
  assert.deepEqual(h.deleted, [[1, 5]]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.text, /Learned anything today\?/);
});

test("a TIL answer is sent as a TIL-prefixed jot and ends the flow", async () => {
  const h = harness({}, [EMPTY]);
  await h.flow.handleReply(reply("owls can't move their eyes"), {
    question: "til",
    date: DATE,
  });
  assert.deepEqual(h.jots, [[DATE, "TIL: owls can't move their eyes"]]);
  assert.deepEqual(h.deleted, [[1, 5]]);
  assert.deepEqual(h.sent, []);
});

test("a journal answer skips the TIL question when the TIL is already filled", async () => {
  const h = harness({}, ["## Journal\n-\n## TIL\n- known\n"]);
  await h.flow.handleReply(reply("ok"), { question: "journal", date: DATE });
  assert.deepEqual(h.sent, []);
});

test("Skip drops the prompt and moves to the next question", async () => {
  const h = harness();
  const t = tap();
  await h.flow.handleTap(t.ctx, "j", DATE);
  assert.deepEqual(h.deleted, [[1, 9]]);
  assert.deepEqual(h.jots, []);
  assert.match(h.sent[0]!.text, /Learned anything today\?/);
});

test("Skip on the last question just clears it", async () => {
  const h = harness();
  await h.flow.handleTap(tap().ctx, "t", DATE);
  assert.deepEqual(h.deleted, [[1, 9]]);
  assert.deepEqual(h.sent, []);
});

test("a Skip tap with a bad code or date is rejected and changes nothing", async () => {
  for (const [code, date] of [
    ["x", DATE],
    ["j", "2026-99-99"],
    ["j", undefined],
    [undefined, DATE],
  ] as const) {
    const h = harness();
    const t = tap();
    await h.flow.handleTap(t.ctx, code, date);
    assert.deepEqual(t.answers, [{ text: "bad follow-up" }]);
    assert.deepEqual(h.deleted, []);
    assert.deepEqual(h.sent, []);
  }
});
