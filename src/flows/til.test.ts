import assert from "node:assert/strict";
import { test } from "node:test";

// til.ts pulls in config.ts, which validates process.env at import time.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { TilFlow } = await import("./til.ts");

function harness(
  over: {
    moved?: "moved" | "no-line" | "no-heading";
    sendFails?: boolean;
  } = {},
) {
  const updates: [string, any][] = [];
  const marked: string[] = [];
  const answers: string[] = [];
  const edits: string[] = [];
  const repo = {
    getJot: async (id: string) => ({
      id,
      status: "done",
      note_path: "notes/daily notes/2026-08-16.md",
      anchor: id,
    }),
    groupFollowers: async () => [{ id: "f0000001" }],
    updateJot: async (id: string, patch: any) => void updates.push([id, patch]),
    markTilOffered: async (id: string) => void marked.push(id),
  };
  const obsidian = { moveToTil: async () => over.moved ?? "moved" };
  const bot = {
    api: {
      sendMessage: async () => {
        if (over.sendFails) throw new Error("telegram down");
        return { message_id: 1 };
      },
    },
  };
  const ctx = {
    answerCallbackQuery: async (o: { text: string }) =>
      void answers.push(o.text),
    editMessageText: async (text: string) => void edits.push(text),
  };
  const flow = new TilFlow(bot as any, repo as any, obsidian as any);
  return { flow, ctx, updates, marked, answers, edits };
}

test("accepting moves the line and follows it with the leader's and followers' section", async () => {
  const h = harness();
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  assert.deepEqual(h.updates, [
    ["abcd1234", { section: "til" }],
    ["f0000001", { section: "til" }],
  ]);
  assert.deepEqual(h.edits, ["💡 Moved to TIL."]);
});

test("a note with no TIL heading is left alone and the card says so", async () => {
  const h = harness({ moved: "no-heading" });
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  assert.deepEqual(h.updates, []);
  assert.match(h.edits[0]!, /no TIL heading/);
});

test("declining changes nothing", async () => {
  const h = harness();
  await h.flow.handleTap(h.ctx, ["n", "abcd1234"]);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.edits, ["🚫 Kept in the journal."]);
});

test("the jot is marked as asked only after the card was sent", async () => {
  const ok = harness();
  await ok.flow.ask("abcd1234", "sqlite has WAL");
  assert.deepEqual(ok.marked, ["abcd1234"]);

  const failed = harness({ sendFails: true });
  await failed.flow.ask("abcd1234", "sqlite has WAL");
  assert.deepEqual(failed.marked, []);
});
