import assert from "node:assert/strict";
import { test } from "node:test";
import { placeholderLine, WIZARD_RATING_TIME_REF } from "./core.ts";
import { type Jot, Repository } from "./db.ts";
import { BOT_INFO, FakeSettings, recordingApi } from "./test/fakes.ts";
import { removeDb, sampleJot, tempDbPath } from "./test/sqlite.ts";
import { plainDate, plainTime, previousDate } from "./time.ts";

// config.ts reads process.env at import time, so the bot is imported after these are set.
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.ALLOWED_TELEGRAM_USER_ID = "1";
process.env.OBSIDIAN_API_KEY = "o";

const NOW = Date.UTC(2026, 7, 16, 10, 0, 0);
const SEC = NOW / 1000;

const leader = (over: Partial<Jot> = {}): Jot =>
  sampleJot("aaaaaaaa", {
    note_path: `notes/daily notes/${plainDate(NOW)}.md`,
    time: plainTime(NOW - 2000),
    raw_text: "earlier",
    received_at: NOW - 2000,
    updated_at: NOW - 2000,
    ...over,
  });

type Fakes = {
  prev?: Jot;
  jot?: Jot;
  jotId?: string;
  unsquash?: boolean;
  appendFails?: boolean;
  realRepo?: Repository;
  /** Offer the newest inserted jot back as the still-pending one, like the real repo. */
  chain?: boolean;
  /** What readDailyNote returns; null (the default) is a day with no note. */
  note?: string | null;
  settings?: Record<string, string>;
};

async function harness(over: Fakes = {}) {
  const { ScribaBot } = await import("./bot.ts");
  const inserted: Jot[] = [];
  const sets: [string, string][] = [];
  const mapped: [number, string][] = [];
  const lookups: [string, string][] = [];
  const appended: [string, string, string | undefined][] = [];
  const ensured: string[] = [];
  const queued: string[] = [];
  const queuedEdits: [string, string][] = [];
  const reacts: string[] = [];
  const replies: string[] = [];
  const statuses: string[] = [];
  const notices: string[] = [];
  const replaced: [Jot, string][] = [];
  const deleted: Jot[] = [];
  const repo = over.realRepo ?? {
    insertJot: async (j: Jot) => void inserted.push(j),
    mapMessage: async (m: number, id: string) => void mapped.push([m, id]),
    lastPendingEnrichableJot: async (notePath: string, section: string) => {
      lookups.push([notePath, section]);
      return over.prev ?? (over.chain ? inserted.at(-1) : undefined);
    },
    ...new FakeSettings(over.settings, (key, value) => sets.push([key, value])),
    jotForMessage: async () => over.jotId,
    getJot: async () => over.jot,
    queueEdit: async (id: string, text: string) =>
      void queuedEdits.push([id, text]),
    unsquash: async () => over.unsquash ?? true,
  };
  const obsidian = {
    dailyPath: (date: string) => `notes/daily notes/${date}.md`,
    ensureDailyNote: async (date: string) => void ensured.push(date),
    readDailyNote: async () =>
      over.note === undefined || over.note === null
        ? null
        : { path: "p", content: over.note },
    appendJournalLine: async (date: string, line: string, section?: string) => {
      if (over.appendFails) throw new Error("obsidian is down");
      appended.push([date, line, section]);
    },
  };
  const bot: any = new ScribaBot(
    repo as any,
    obsidian as any,
    {} as any,
    {} as any,
    {} as any,
  );
  bot.setQueue({ add: (ids: string[]) => void queued.push(...ids) });
  bot.status = async (_id: string, text: string) => void statuses.push(text);
  bot.notify = async (text: string) => void notices.push(text);
  bot.replaceJotText = async (j: Jot, text: string) => {
    replaced.push([j, text]);
    return "replaced";
  };
  bot.deleteJot = async (j: Jot) => {
    deleted.push(j);
    return "deleted";
  };
  bot.embedFor = async () => undefined;
  const sent: string[] = [];
  const apiDeleted: [number, number][] = [];
  bot.bot.api.sendMessage = async (_chat: number, text: string) =>
    void sent.push(text);
  bot.bot.api.deleteMessage = async (chat: number, id: number) =>
    void apiDeleted.push([chat, id]);

  const intakeCtx = (date = SEC, messageId = 77) => ({
    message: { date, message_id: messageId },
    react: async (e: string) => void reacts.push(e),
  });
  const editCtx = () => ({
    editedMessage: { message_id: 77 },
    reply: async (t: string) => void replies.push(t),
  });
  const reactionCtx = (emoji = "🤝", messageId: number | undefined = 77) => ({
    reactions: () => ({ emojiAdded: [emoji] }),
    messageReaction: messageId ? { message_id: messageId } : undefined,
    react: async (e: string) => void reacts.push(e),
  });
  return {
    bot,
    sent,
    sets,
    apiDeleted,
    inserted,
    mapped,
    lookups,
    appended,
    ensured,
    queued,
    queuedEdits,
    reacts,
    replies,
    statuses,
    notices,
    replaced,
    deleted,
    intakeCtx,
    editCtx,
    reactionCtx,
    intake: (kind: string, src: object, ctx = intakeCtx()) =>
      bot.intake(ctx, kind, src),
  };
}

const today = plainDate(NOW);
const notePath = `notes/daily notes/${today}.md`;

test("a TIL text jot is stored stripped, in the til section, and written under it", async () => {
  const h = await harness();
  await h.intake("text", { rawText: "TIL: sqlite has WAL mode" });
  const row = h.inserted[0]!;
  assert.equal(row.section, "til");
  assert.equal(row.raw_text, "sqlite has WAL mode");
  assert.deepEqual(h.lookups, [[notePath, "til"]]);
  assert.deepEqual(h.appended, [
    [today, placeholderLine(row.time, row.id), "til"],
  ]);
  assert.deepEqual(h.mapped, [[77, row.id]]);
  assert.deepEqual(h.queued, [row.id]);
  assert.deepEqual(h.reacts, ["✍"]);
});

test("a plain text jot stays in the journal section untouched", async () => {
  const h = await harness();
  await h.intake("text", { rawText: "bought milk" });
  const row = h.inserted[0]!;
  assert.equal(row.section, "journal");
  assert.equal(row.raw_text, "bought milk");
  assert.deepEqual(h.lookups, [[notePath, "journal"]]);
  assert.equal(h.appended[0]?.[2], "journal");
});

test("only text jots are checked for the TIL marker", async () => {
  const audio = await harness();
  await audio.intake("audio", { fileId: "f1", rawText: "TIL something" });
  assert.equal(audio.inserted[0]?.section, "journal");
  assert.equal(audio.inserted[0]?.raw_text, "TIL something");

  const image = await harness();
  await image.intake("image", { fileId: "f2", rawText: "TIL: a cat" });
  assert.equal(image.inserted[0]?.section, "journal");
  assert.equal(image.inserted[0]?.raw_text, "TIL: a cat");
});

test("known limitation: 'til' the English word sends a jot to the TIL section", async () => {
  for (const [text, stored] of [
    ["til noon I slept", "noon I slept"],
    ["Til midnight", "midnight"],
    ["til 5pm", "5pm"],
  ] as const) {
    const h = await harness();
    await h.intake("text", { rawText: text });
    assert.equal(h.inserted[0]?.section, "til", text);
    assert.equal(h.inserted[0]?.raw_text, stored, text);
    assert.equal(h.appended[0]?.[2], "til", text);
  }
});

test("a jot with no text at all is a journal jot with a null raw_text", async () => {
  const h = await harness();
  await h.intake("text", {});
  assert.equal(h.inserted[0]?.section, "journal");
  assert.equal(h.inserted[0]?.raw_text, null);
});

test("a TIL jot squashes into a pending TIL leader and writes no placeholder", async () => {
  const h = await harness({ prev: leader({ section: "til" }) });
  await h.intake("text", { rawText: "TIL: second fact" });
  const row = h.inserted[0]!;
  assert.equal(row.anchor, "aaaaaaaa");
  assert.equal(row.section, "til");
  assert.deepEqual(h.reacts, ["🤝"]);
  assert.deepEqual(h.appended, []);
});

test("a TIL leader outside the squash window is not joined", async () => {
  const h = await harness({
    prev: leader({ section: "til", received_at: NOW - 60_000 }),
  });
  await h.intake("text", { rawText: "TIL: later fact" });
  const row = h.inserted[0]!;
  assert.equal(row.anchor, row.id);
  assert.deepEqual(h.reacts, ["✍"]);
  assert.equal(h.appended[0]?.[2], "til");
});

test("a voice jot squashes into a journal leader and keeps the journal section", async () => {
  const h = await harness({ prev: leader() });
  await h.intake("audio", { fileId: "f1" });
  assert.equal(h.inserted[0]?.anchor, "aaaaaaaa");
  assert.equal(h.inserted[0]?.section, "journal");
  assert.deepEqual(h.lookups, [[notePath, "journal"]]);
});

test("image and video jots never look for a squash leader", async () => {
  for (const kind of ["image", "video"]) {
    const h = await harness({ prev: leader() });
    await h.intake(kind, { fileId: "f1" });
    assert.deepEqual(h.lookups, [], kind);
    assert.equal(h.inserted[0]?.section, "journal", kind);
    assert.equal(h.inserted[0]?.anchor, h.inserted[0]?.id, kind);
  }
});

test("a failed placeholder write still leaves the til row mapped and unqueued", async () => {
  const h = await harness({ appendFails: true });
  await assert.rejects(
    () => h.intake("text", { rawText: "TIL: x y" }),
    /obsidian is down/,
  );
  assert.equal(h.inserted[0]?.section, "til");
  assert.equal(h.mapped.length, 1);
  assert.deepEqual(h.queued, []);
});

test("a TIL jot does not join a pending journal jot in the real repository", async (t) => {
  const dbPath = tempDbPath();
  let repo: Repository;
  try {
    repo = await Repository.open(dbPath);
  } catch (e) {
    return t.skip(
      `native sqlite unavailable: ${(e as Error).message.slice(0, 80)}`,
    );
  }
  try {
    await repo.insertJot(leader());
    const h = await harness({ realRepo: repo });
    await h.bot.intake(h.intakeCtx(), "text", { rawText: "TIL: x y" });
    const til = await repo.getJot((await repo.jotForMessage(77))!);
    assert.equal(til?.section, "til");
    assert.equal(til?.anchor, til?.id);
    assert.deepEqual(h.reacts, ["✍"]);

    // and the other way round: a plain jot after the TIL jot skips it and rejoins the
    // journal run it left off
    await h.bot.intake(h.intakeCtx(SEC + 1, 78), "text", { rawText: "plain" });
    const plain = await repo.getJot((await repo.jotForMessage(78))!);
    assert.equal(plain?.section, "journal");
    assert.equal(plain?.anchor, "aaaaaaaa");
    assert.deepEqual(h.reacts, ["✍", "🤝"]);
  } finally {
    await repo.close();
    await removeDb(dbPath);
  }
});

const tilJot = (over: Partial<Jot> = {}) =>
  leader({ section: "til", status: "done", ...over });

test("an edited TIL message loses a re-typed marker before it is applied", async () => {
  const h = await harness({ jotId: "aaaaaaaa", jot: tilJot() });
  await h.bot.applyMessageEdit(h.editCtx(), "TIL: sqlite WAL");
  assert.equal(h.replaced[0]?.[1], "sqlite WAL");
  assert.deepEqual(h.statuses, ["✍️ got your edit — applying…", "replaced"]);
});

test("an edited journal message keeps a leading TIL as typed", async () => {
  const h = await harness({
    jotId: "aaaaaaaa",
    jot: leader({ status: "done" }),
  });
  await h.bot.applyMessageEdit(h.editCtx(), "TIL: foo");
  assert.equal(h.replaced[0]?.[1], "TIL: foo");
});

test("an edit of a TIL jot still processing is queued without the marker", async () => {
  for (const status of ["pending", "processing"] as const) {
    const h = await harness({ jotId: "aaaaaaaa", jot: tilJot({ status }) });
    await h.bot.applyMessageEdit(h.editCtx(), "TIL: new");
    assert.deepEqual(h.queuedEdits, [["aaaaaaaa", "new"]], status);
    assert.match(h.replies[0]!, /apply that edit once it's done/, status);
  }
});

test("blanking a TIL message deletes it, and a bare marker is kept as text", async () => {
  for (const blank of ["", "   ", "\n"]) {
    const queued = await harness({
      jotId: "aaaaaaaa",
      jot: tilJot({ status: "processing" }),
    });
    await queued.bot.applyMessageEdit(queued.editCtx(), blank);
    assert.deepEqual(queued.queuedEdits, [["aaaaaaaa", "delete"]]);
    assert.match(queued.replies[0]!, /remove it once it's done/);

    const done = await harness({ jotId: "aaaaaaaa", jot: tilJot() });
    await done.bot.applyMessageEdit(done.editCtx(), blank);
    assert.equal(done.deleted.length, 1);
    assert.equal(done.statuses[0], "🗑️ got it — removing…");
  }
  for (const bare of ["TIL", "TIL:", "TIL   "]) {
    const h = await harness({ jotId: "aaaaaaaa", jot: tilJot() });
    await h.bot.applyMessageEdit(h.editCtx(), bare);
    assert.equal(h.replaced[0]?.[1], bare);
    assert.equal(h.deleted.length, 0);
  }
});

test("an edit with no mapped message or no jot does nothing", async () => {
  const unmapped = await harness({ jotId: undefined });
  await unmapped.bot.applyMessageEdit(unmapped.editCtx(), "TIL: x y");
  assert.deepEqual(
    [
      unmapped.replaced,
      unmapped.queuedEdits,
      unmapped.replies,
      unmapped.statuses,
    ],
    [[], [], [], []],
  );

  const gone = await harness({ jotId: "aaaaaaaa", jot: undefined });
  await gone.bot.applyMessageEdit(gone.editCtx(), "TIL: x y");
  assert.deepEqual(
    [gone.replaced, gone.queuedEdits, gone.replies, gone.statuses],
    [[], [], [], []],
  );
});

test("an un-squashed TIL follower is re-appended under the til section", async () => {
  const follower = tilJot({
    id: "bbbbbbbb",
    anchor: "aaaaaaaa",
    status: "pending",
  });
  const h = await harness({ jotId: "bbbbbbbb", jot: follower });
  await h.bot.handleMergeReaction(h.reactionCtx());
  assert.deepEqual(h.appended, [
    [
      plainDate(follower.received_at),
      placeholderLine(follower.time, "bbbbbbbb"),
      "til",
    ],
  ]);
  assert.deepEqual(h.reacts, ["✍"]);
});

test("an un-squashed journal follower is re-appended under the journal section", async () => {
  const follower = leader({ id: "bbbbbbbb", anchor: "aaaaaaaa" });
  const h = await harness({ jotId: "bbbbbbbb", jot: follower });
  await h.bot.handleMergeReaction(h.reactionCtx());
  assert.equal(h.appended[0]?.[2], "journal");
});

test("the opt-out writes the placeholder on the jot's own day, not today's", async () => {
  const received = Date.UTC(2020, 0, 2, 23, 59, 0);
  const follower = tilJot({
    id: "bbbbbbbb",
    anchor: "aaaaaaaa",
    received_at: received,
  });
  const h = await harness({ jotId: "bbbbbbbb", jot: follower });
  await h.bot.handleMergeReaction(h.reactionCtx());
  assert.deepEqual(h.ensured, [plainDate(received)]);
  assert.equal(h.appended[0]?.[0], plainDate(received));
  assert.notEqual(plainDate(received), today);
});

test("the merge opt-out ignores what it should and reports a late tap", async () => {
  const follower = tilJot({ id: "bbbbbbbb", anchor: "aaaaaaaa" });

  const wrongEmoji = await harness({ jotId: "bbbbbbbb", jot: follower });
  await wrongEmoji.bot.handleMergeReaction(wrongEmoji.reactionCtx("👍"));
  const noMessage = await harness({ jotId: "bbbbbbbb", jot: follower });
  await noMessage.bot.handleMergeReaction(noMessage.reactionCtx("🤝", 0));
  const unknown = await harness({ jotId: undefined });
  await unknown.bot.handleMergeReaction(unknown.reactionCtx());
  const isLeader = await harness({ jotId: "aaaaaaaa", jot: tilJot() });
  await isLeader.bot.handleMergeReaction(isLeader.reactionCtx());
  for (const h of [wrongEmoji, noMessage, unknown, isLeader])
    assert.deepEqual([h.appended, h.notices], [[], []]);

  const late = await harness({
    jotId: "bbbbbbbb",
    jot: follower,
    unsquash: false,
  });
  await late.bot.handleMergeReaction(late.reactionCtx());
  assert.deepEqual(late.appended, []);
  assert.match(late.notices[0]!, /too late/);
});

test("the bot builds its TIL card flow in the constructor", async () => {
  const { TilFlow } = await import("./flows/til.ts");
  const h = await harness();
  assert.ok(h.bot.til instanceof TilFlow);
});

/** Push one button tap through the bot's real middleware. Returns how many times the tap
 *  was answered, so a test can tell a routed tap from one the fallthrough swallowed. */
async function tap(
  h: Awaited<ReturnType<typeof harness>>,
  data: string,
): Promise<number> {
  const rec = recordingApi();
  h.bot.bot.botInfo = BOT_INFO;
  h.bot.bot.api.config.use(rec.transformer as never);
  await h.bot.bot.handleUpdate({
    update_id: 1,
    callback_query: {
      id: "q",
      from: { id: 1, is_bot: false, first_name: "me" },
      chat_instance: "c",
      data,
      message: {
        message_id: 4,
        date: SEC,
        chat: { id: 1, type: "private" },
        text: "card",
      },
    },
  });
  return rec.answers().length;
}

test("a ti: button goes to the TIL flow and the fallthrough never answers it", async () => {
  const h = await harness();
  const taps: [string, string[]][] = [];
  h.bot.til.handleTap = async (
    ctx: { callbackQuery: { data: string } },
    rest: string[],
  ) => {
    taps.push([ctx.callbackQuery.data, rest]);
  };
  const answered = await tap(h, "ti:y:abcd1234");
  assert.deepEqual(taps, [["ti:y:abcd1234", ["y", "abcd1234"]]]);
  assert.equal(answered, 0);
});

test("askTil hands the jot and its text to the TIL flow", async () => {
  const h = await harness();
  const asks: [string, string][] = [];
  h.bot.til = {
    ask: async (id: string, text: string) => void asks.push([id, text]),
  };
  assert.equal(await h.bot.askTil("abcd1234", "TIL: x"), undefined);
  assert.deepEqual(asks, [["abcd1234", "TIL: x"]]);
});

test("a reply instruction to a TIL jot still processing is queued verbatim", async () => {
  const h = await harness({
    jotId: "aaaaaaaa",
    jot: tilJot({ status: "processing" }),
  });
  const ctx = {
    message: {
      text: "TIL: make it shorter",
      reply_to_message: { message_id: 77 },
    },
    reply: async (t: string) => void h.replies.push(t),
  };
  await h.bot.handleEdit(ctx);
  assert.deepEqual(h.queuedEdits, [["aaaaaaaa", "TIL: make it shorter"]]);
});

// --- follow-up after the nightly rating ---

const rated = previousDate(NOW);
const ratedPath = `notes/daily notes/${rated}.md`;

/** A reply to a follow-up prompt, as grammY would hand it to FollowupFlow.handleReply. */
const answerCtx = (h: { reacts: string[] }, text: string, sec = SEC) => ({
  chat: { id: 1 },
  message: {
    date: sec,
    message_id: 77,
    text,
    reply_to_message: { message_id: 9 },
  },
  react: async (e: string) => void h.reacts.push(e),
});

test("a journal answer is filed under the rated day as its last entry", async () => {
  const h = await harness();
  await h.bot.followup.handleReply(answerCtx(h, "Quiet day"), {
    question: "journal",
    date: rated,
  });
  assert.equal(h.inserted.length, 1);
  const row = h.inserted[0]!;
  assert.equal(row.note_path, ratedPath);
  assert.equal(row.time, "23:59:59");
  assert.equal(row.section, "journal");
  assert.equal(row.raw_text, "Quiet day");
  assert.equal(row.kind, "text");
  assert.deepEqual(h.ensured, [rated]);
  assert.deepEqual(h.apiDeleted, [[1, 9]]);
});

test("a TIL answer goes through the TIL prefix into the til section", async () => {
  const h = await harness();
  await h.bot.followup.handleReply(answerCtx(h, "owls"), {
    question: "til",
    date: rated,
  });
  const row = h.inserted[0]!;
  assert.equal(row.section, "til");
  assert.equal(row.raw_text, "owls");
  assert.equal(row.note_path, ratedPath);
  assert.equal(h.appended[0]?.[2], "til");
});

test("two answers for one past day never squash, even seconds apart", async () => {
  const h = await harness({ chain: true });
  await h.bot.followup.handleReply(answerCtx(h, "one"), {
    question: "journal",
    date: rated,
  });
  await h.bot.followup.handleReply(answerCtx(h, "two", SEC + 2), {
    question: "journal",
    date: rated,
  });
  assert.equal(h.inserted.length, 2);
  for (const row of h.inserted) assert.equal(row.anchor, row.id);
  assert.deepEqual(h.lookups, []);
  assert.deepEqual(h.reacts, ["✍", "✍"]);
});

test("an answer for the day it is sent on keeps its real time and skips squashing", async () => {
  const h = await harness({ chain: true });
  const ctx = h.intakeCtx();
  await h.bot.intake(ctx, "text", { rawText: "now", day: today });
  const row = h.inserted[0]!;
  assert.equal(row.time, plainTime(NOW));
  assert.equal(row.received_at, NOW);
  assert.equal(row.note_path, notePath);
  assert.deepEqual(h.lookups, []);
});

test("the day override gives 23:59:59 on DST change days", async () => {
  const saved = process.env.TZ;
  process.env.TZ = "Europe/Stockholm";
  try {
    for (const [day, next] of [
      ["2026-03-29", new Date(2026, 2, 30, 0, 10)],
      ["2026-10-25", new Date(2026, 9, 26, 0, 10)],
    ] as const) {
      const h = await harness();
      await h.bot.intake(h.intakeCtx(next.getTime() / 1000), "text", {
        rawText: "x",
        day,
      });
      assert.equal(h.inserted[0]?.time, "23:59:59", day);
      assert.equal(
        h.inserted[0]?.note_path,
        `notes/daily notes/${day}.md`,
        day,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("the rating command is wired to the same follow-up flow", async () => {
  const h = await harness();
  assert.equal(h.bot.rating.followup, h.bot.followup);
});

test("setScheduler hands the scheduler to the menu", async () => {
  const h = await harness();
  const seen: unknown[] = [];
  h.bot.menu = { setScheduler: (s: unknown) => void seen.push(s) };
  const scheduler = {};
  h.bot.setScheduler(scheduler);
  assert.deepEqual(seen, [scheduler]);
  assert.equal(seen[0], scheduler);
});

test("a rating time typed in the menu reaches the scheduler, and works without one", async () => {
  const prompt = `when? ${WIZARD_RATING_TIME_REF}`;
  const reply = (h: { replies: string[] }) => ({
    message: { text: "23:30" },
    reply: async (t: string) => {
      h.replies.push(t);
      return { chat: { id: 1 }, message_id: 2 };
    },
  });

  const wired = await harness();
  const rearmed: string[] = [];
  wired.bot.setScheduler({ rearm: async (n: string) => void rearmed.push(n) });
  await wired.bot.menu.handleWizardReply(reply(wired), prompt);
  assert.deepEqual(wired.sets, [["ratingTime", "23:30"]]);
  assert.deepEqual(rearmed, ["rating"]);

  const bare = await harness();
  await bare.bot.menu.handleWizardReply(reply(bare), prompt);
  assert.deepEqual(bare.sets, [["ratingTime", "23:30"]]);
});

/** Push one text update through the bot's real middleware, with the handlers under test
 *  replaced by recorders. */
async function route(
  h: Awaited<ReturnType<typeof harness>>,
  replyText: string | undefined,
  opts: { tasksOpen?: boolean } = {},
) {
  const calls: string[] = [];
  const bot = h.bot;
  bot.bot.botInfo = BOT_INFO;
  bot.followup.handleReply = async (_c: unknown, ref: unknown) =>
    void calls.push(`followup:${JSON.stringify(ref)}`);
  bot.habits.handleReply = async () => void calls.push("habits");
  bot.menu.handleWizardReply = async () => void calls.push("wizard");
  bot.tasks.handleReply = async () => void calls.push("taskPrompt");
  bot.tasks.handle = async () => void calls.push("tasks");
  bot.tasks.isOpen = () => opts.tasksOpen ?? false;
  bot.handleEdit = async () => void calls.push("edit");
  bot.intake = async () => void calls.push("intake");
  await bot.bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 5,
      date: SEC,
      chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false, first_name: "me" },
      text: "my answer",
      reply_to_message:
        replyText === undefined
          ? undefined
          : {
              message_id: 4,
              date: SEC,
              chat: { id: 1, type: "private" },
              text: replyText,
            },
    },
  });
  return calls;
}

test("a reply to a follow-up prompt goes to the follow-up flow and nowhere else", async () => {
  const h = await harness();
  const calls = await route(
    h,
    "One line for the day? Reply to this message, or skip.\n(fu:j:2026-07-05)",
  );
  assert.deepEqual(calls, [
    'followup:{"question":"journal","date":"2026-07-05"}',
  ]);
});

test("a follow-up reply wins over an open task mode", async () => {
  const h = await harness();
  const calls = await route(h, "(fu:t:2026-07-05)", { tasksOpen: true });
  assert.deepEqual(calls, ['followup:{"question":"til","date":"2026-07-05"}']);
});

test("an ordinary reply still goes to jot editing, and an unreplied message to intake", async () => {
  const h = await harness();
  assert.deepEqual(await route(h, "hello"), ["edit"]);
  assert.deepEqual(await route(await harness(), undefined), ["intake"]);
});

test("the Skip button is routed to the follow-up flow with its payload", async () => {
  const h = await harness();
  const taps: unknown[][] = [];
  h.bot.followup.handleTap = async (...args: unknown[]) =>
    void taps.push(args.slice(1));
  for (const data of ["fu:j:2026-07-05", "fu:t:2026-07-05"])
    assert.equal(await tap(h, data), 0, data);
  assert.deepEqual(taps, [
    ["j", "2026-07-05"],
    ["t", "2026-07-05"],
  ]);
});
