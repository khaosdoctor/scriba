import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "./db.ts";
import { testConfig } from "./test/config.ts";
import { sampleJot } from "./test/sqlite.ts";
import { plainDate, plainTime } from "./time.ts";

const NOW = Date.UTC(2026, 7, 16, 10, 0, 0);

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
  jot?: Jot;
  jotId?: string;
};

async function harness(over: Fakes = {}) {
  const { ScribaBot } = await import("./bot.ts");
  const queuedEdits: [string, string][] = [];
  const replies: string[] = [];
  const statuses: string[] = [];
  const replaced: [Jot, string][] = [];
  const deleted: Jot[] = [];
  const repo = {
    jotForMessage: async () => over.jotId,
    getJot: async () => over.jot,
    queueEdit: async (id: string, text: string) =>
      void queuedEdits.push([id, text]),
  };
  const bot: any = new ScribaBot(
    testConfig,
    repo as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  bot.status = async (_id: string, text: string) => void statuses.push(text);
  bot.replaceJotText = async (j: Jot, text: string) => {
    replaced.push([j, text]);
    return "replaced";
  };
  bot.deleteJot = async (j: Jot) => {
    deleted.push(j);
    return "deleted";
  };
  bot.embedFor = async () => undefined;

  const editCtx = () => ({
    editedMessage: { message_id: 77 },
    reply: async (t: string) => void replies.push(t),
  });
  return {
    bot,
    queuedEdits,
    replies,
    statuses,
    replaced,
    deleted,
    editCtx,
  };
}

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

test("askTil hands the jot and its text to the TIL flow", async () => {
  const h = await harness();
  const asks: [string, string][] = [];
  h.bot.jotController.askTil = async (id: string, text: string) =>
    void asks.push([id, text]);
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
