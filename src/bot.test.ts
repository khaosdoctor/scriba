import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { placeholderLine } from "./core.ts";
import { type Jot, Repository } from "./db.ts";
import { plainDate, plainTime } from "./time.ts";

// config.ts reads process.env at import time, so the bot is imported after these are set.
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.ALLOWED_TELEGRAM_USER_ID = "1";
process.env.OBSIDIAN_API_KEY = "o";

const NOW = Date.UTC(2026, 7, 16, 10, 0, 0);
const SEC = NOW / 1000;

const leader = (over: Partial<Jot> = {}): Jot => ({
  id: "aaaaaaaa",
  kind: "text",
  note_path: `notes/daily notes/${plainDate(NOW)}.md`,
  anchor: "aaaaaaaa",
  time: plainTime(NOW - 2000),
  raw_text: "earlier",
  transcript: null,
  proposed_text: null,
  section: "journal",
  asset_path: null,
  file_id: null,
  status: "pending",
  attempts: 0,
  error: null,
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
};

async function harness(over: Fakes = {}) {
  const { ScribaBot } = await import("./bot.ts");
  const inserted: Jot[] = [];
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
      return over.prev;
    },
    jotForMessage: async () => over.jotId,
    getJot: async () => over.jot,
    queueEdit: async (id: string, text: string) =>
      void queuedEdits.push([id, text]),
    unsquash: async () => over.unsquash ?? true,
  };
  const obsidian = {
    dailyPath: (date: string) => `notes/daily notes/${date}.md`,
    ensureDailyNote: async (date: string) => void ensured.push(date),
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
    {} as any,
    "0.0.0",
    "sha",
    0,
  );
  bot.setQueue({ add: (id: string) => void queued.push(id) });
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
  const dbPath = join(
    tmpdir(),
    `scriba-bot-${randomBytes(6).toString("hex")}.db`,
  );
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
    for (const suffix of ["", "-shm", "-wal"])
      await rm(`${dbPath}${suffix}`, { force: true });
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

test("a ti: button goes to the TIL flow and the fallthrough never answers it", async () => {
  const h = await harness();
  const taps: [unknown, string[]][] = [];
  h.bot.til = {
    handleTap: async (ctx: unknown, rest: string[]) => {
      taps.push([ctx, rest]);
    },
  };
  let answered = 0;
  const ctx = {
    callbackQuery: { data: "ti:y:abcd1234" },
    answerCallbackQuery: async () => void answered++,
  };
  await h.bot.handleButton(ctx);
  assert.deepEqual(taps, [[ctx, ["y", "abcd1234"]]]);
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
