import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS, type SettingKey } from "../models/settings.ts";

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
  opts: { deleteFails?: boolean; jotFails?: boolean } = {},
) {
  const sent: { text: string; opts: any }[] = [];
  const deleted: [number, number][] = [];
  const jots: [string, string][] = [];
  const keys: string[] = [];
  let reads = 0;
  const bot = {
    api: {
      sendMessage: async (_chat: number, text: string, opts: any) =>
        void sent.push({ text, opts }),
      deleteMessage: async (chat: number, id: number) => {
        deleted.push([chat, id]);
        if (opts.deleteFails) throw new Error("message to delete not found");
      },
    },
  };
  const repo = {
    getSetting: async (key: SettingKey) => {
      keys.push(key);
      return SETTINGS[key].parse(settings[key]);
    },
  };
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
    async (_ctx, date, text) => {
      if (opts.jotFails) throw new Error("intake failed");
      jots.push([date, text]);
    },
  );
  return { flow, sent, deleted, jots, keys };
}

const { parseFollowupRef } = await import("../core.ts");

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

test("a prompt Telegram won't delete does not stop Skip from asking the next question", async () => {
  const h = harness({}, [EMPTY], { deleteFails: true });
  const t = tap();
  await h.flow.handleTap(t.ctx, "j", DATE);
  assert.equal(t.answers.length, 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.text, /Learned anything today\?/);
});

test("a prompt Telegram won't delete does not stop a reply from asking the next question", async () => {
  const h = harness({}, [EMPTY], { deleteFails: true });
  await h.flow.handleReply(reply("ok"), { question: "journal", date: DATE });
  assert.deepEqual(h.jots, [[DATE, "ok"]]);
  assert.match(h.sent[0]!.text, /Learned anything today\?/);
});

test("a failed intake keeps the prompt and asks nothing more", async () => {
  const h = harness({}, [EMPTY], { jotFails: true });
  await assert.rejects(
    h.flow.handleReply(reply("ok"), { question: "journal", date: DATE }),
    /intake failed/,
  );
  assert.deepEqual(h.deleted, []);
  assert.deepEqual(h.sent, []);
});

test("a reply's formatting is kept and its surrounding whitespace trimmed", async () => {
  const entities = [{ type: "bold", offset: 8, length: 5 }];
  const message = (text: string) => ({
    chat: { id: 1 },
    message: { text, entities, reply_to_message: { message_id: 5 } },
  });
  const h = harness();
  await h.flow.handleReply(message("  hello world  "), {
    question: "journal",
    date: DATE,
  });
  await h.flow.handleReply(message("  hello world  "), {
    question: "til",
    date: DATE,
  });
  assert.deepEqual(h.jots, [
    [DATE, "hello **world**"],
    [DATE, "TIL: hello **world**"],
  ]);
});

test("the flow adds nothing to an answer beyond the TIL prefix", async () => {
  const long = "x".repeat(5000);
  const cases: [string, string, string][] = [
    ["journal", "😴 slept 10h ☕", "😴 slept 10h ☕"],
    ["journal", "line1\r\nline2", "line1\r\nline2"],
    ["journal", long, long],
    ["til", "TIL: x", "TIL: TIL: x"],
    ["journal", "til noon I slept", "til noon I slept"],
  ];
  for (const [question, text, sent] of cases) {
    const h = harness({}, [JOTTED]);
    await h.flow.handleReply(reply(text), {
      question: question as "journal" | "til",
      date: DATE,
    });
    assert.deepEqual(h.jots, [[DATE, sent]], text.slice(0, 20));
  }
});

test("known limitation: a journal answer starting with 'til' reaches intake as-is, where the TIL prefix rule files it under TIL", async () => {
  // The flow does not guard against it; bot.test.ts shows what intake does with the text.
  const h = harness();
  await h.flow.handleReply(reply("til noon I slept"), {
    question: "journal",
    date: DATE,
  });
  assert.equal(h.jots[0]?.[1], "til noon I slept");
});

test("the next question is read from the note after the answer, and only looks forward", async () => {
  const filled = "## Journal\n- a\n## TIL\n- b\n";
  const afterJournal = harness({}, [filled]);
  await afterJournal.flow.handleReply(reply("x"), {
    question: "journal",
    date: DATE,
  });
  assert.deepEqual(afterJournal.sent, []);

  // The journal jot was undone meanwhile: answering the TIL must not go back to it.
  const afterTil = harness({}, [EMPTY]);
  await afterTil.flow.handleReply(reply("x"), { question: "til", date: DATE });
  assert.deepEqual(afterTil.sent, []);
});

test("a fresh flow answers a prompt sent by another, so no state is shared", async () => {
  const first = harness();
  await first.flow.start(DATE);
  const promptText = first.sent[0]!.text;

  const second = harness();
  const ref = parseFollowupRef(promptText);
  assert.ok(ref);
  await second.flow.handleReply(reply("Quiet"), ref);
  assert.deepEqual(second.jots, [[DATE, "Quiet"]]);
  assert.match(second.sent[0]!.text, /Learned anything today\?/);
});

test("a prompt's text and Skip payload route back to the same question and day", async () => {
  for (const [notes, code] of [
    [[EMPTY], "j"],
    [[JOTTED], "t"],
  ] as const) {
    const h = harness({}, [...notes]);
    await h.flow.start(DATE);
    const { text, opts } = h.sent[0]!;
    const ref = parseFollowupRef(text);
    assert.equal(ref?.date, DATE);
    assert.ok(text.length < 200);
    assert.match(text, /\(fu:[jt]:2026-07-05\)$/);
    const [ns, c, date] =
      opts.reply_markup.inline_keyboard[0][0].callback_data.split(":");
    assert.equal(ns, "fu");
    assert.equal(c, code);
    assert.equal(date, DATE);
  }
});

test("start reads the follow-up switch and never the rating's", async () => {
  const h = harness();
  await h.flow.start(DATE);
  assert.deepEqual(h.keys, ["nightlyFollowup"]);
});

test("two concurrent Skip taps on one prompt ask the next question once", async () => {
  const h = harness();
  const t = tap();
  await Promise.all([
    h.flow.handleTap(t.ctx, "j", DATE),
    h.flow.handleTap(t.ctx, "j", DATE),
  ]);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.deleted, [[1, 9]]);
  assert.equal(t.answers.length, 2);
});

test("a repeated Skip tap later on is ignored too, but another prompt still works", async () => {
  const h = harness();
  const first = tap();
  await h.flow.handleTap(first.ctx, "j", DATE);
  await h.flow.handleTap(first.ctx, "j", DATE);
  assert.equal(h.sent.length, 1);

  const other = tap();
  other.ctx.callbackQuery.message.message_id = 10;
  await h.flow.handleTap(other.ctx, "j", DATE);
  assert.equal(h.sent.length, 2);
});

test("Skip on a stale prompt asks from the note as it is now", async () => {
  const filled = "## Journal\n- a\n## TIL\n- b\n";
  const done = harness({}, [filled]);
  await done.flow.handleTap(tap().ctx, "j", DATE);
  assert.deepEqual(done.sent, []);

  const tilOnly = harness({}, [JOTTED]);
  await tilOnly.flow.handleTap(tap().ctx, "j", DATE);
  assert.match(tilOnly.sent[0]!.text, /Learned anything today\?/);

  const old = harness();
  await old.flow.handleTap(tap().ctx, "j", "2026-06-25");
  assert.match(old.sent[0]!.text, /\(fu:t:2026-06-25\)/);
});

test("a Skip tap whose message is gone is acknowledged and stops", async () => {
  const h = harness();
  const answers: unknown[] = [];
  const ctx = {
    chat: { id: 1 },
    callbackQuery: {},
    answerCallbackQuery: async (a?: unknown) => void answers.push(a),
  };
  await h.flow.handleTap(ctx, "j", DATE);
  assert.equal(answers.length, 1);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.deleted, []);
});
