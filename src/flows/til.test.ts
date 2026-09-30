import assert from "node:assert/strict";
import { test } from "node:test";

// til.ts pulls in config.ts, which validates process.env at import time.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { TilFlow } = await import("./til.ts");
const { moveAnchorLine } = await import("../core.ts");

type Moved = "moved" | "no-line" | "no-heading";

function harness(
  over: {
    moved?: Moved;
    sendFails?: (text: string) => boolean;
    jot?: object | null;
    followers?: { id: string }[];
    moveFails?: boolean;
    answerFails?: boolean;
    move?: (path: string, anchor: string) => Promise<Moved>;
  } = {},
) {
  const updates: [string, any][] = [];
  const marked: string[] = [];
  const answers: string[] = [];
  const edits: { text: string; markup: any }[] = [];
  const lookups: string[] = [];
  const moves: [string, string][] = [];
  const sends: { chat: number; text: string; opts: any }[] = [];
  const repo = {
    getJot: async (id: string) => {
      lookups.push(id);
      if (over.jot === null) return undefined;
      return {
        id,
        status: "done",
        note_path: "notes/daily notes/2026-08-16.md",
        anchor: id,
        ...over.jot,
      };
    },
    groupFollowers: async () => over.followers ?? [{ id: "f0000001" }],
    updateJot: async (id: string, patch: any) => void updates.push([id, patch]),
    markTilOffered: async (id: string) => void marked.push(id),
  };
  const obsidian = {
    moveToTil: async (path: string, anchor: string) => {
      moves.push([path, anchor]);
      if (over.moveFails) throw new Error("obsidian is down");
      return over.move ? over.move(path, anchor) : (over.moved ?? "moved");
    },
  };
  const bot = {
    api: {
      sendMessage: async (chat: number, text: string, opts: any) => {
        if (over.sendFails?.(text)) throw new Error("telegram rejected it");
        sends.push({ chat, text, opts });
        return { message_id: 1 };
      },
    },
  };
  const ctx = {
    answerCallbackQuery: async (o: { text: string }) => {
      if (over.answerFails) throw new Error("query is too old");
      answers.push(o.text);
    },
    editMessageText: async (text: string, opts: any) =>
      void edits.push({ text, markup: opts.reply_markup }),
  };
  const flow = new TilFlow(bot as any, repo as any, obsidian as any);
  return {
    flow,
    ctx,
    updates,
    marked,
    answers,
    edits,
    lookups,
    moves,
    sends,
    repo,
    obsidian,
  };
}

test("accepting moves the line and follows it with the leader's and followers' section", async () => {
  const h = harness();
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  assert.deepEqual(h.updates, [
    ["abcd1234", { section: "til" }],
    ["f0000001", { section: "til" }],
  ]);
  assert.deepEqual(
    h.edits.map((e) => e.text),
    ["💡 Moved to TIL."],
  );
  assert.deepEqual(h.answers, ["moved to TIL"]);
});

test("a jot with no followers gets exactly one section update", async () => {
  const h = harness({ followers: [] });
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  assert.deepEqual(h.updates, [["abcd1234", { section: "til" }]]);
});

test("a note with no TIL heading is left alone and the card says so", async () => {
  const h = harness({ moved: "no-heading" });
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  assert.deepEqual(h.updates, []);
  assert.match(h.edits[0]!.text, /no TIL heading/);
  assert.deepEqual(h.answers, ["no TIL heading"]);
});

test("a line that is gone from the note changes nothing and says so", async () => {
  const h = harness({ moved: "no-line" });
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  assert.deepEqual(h.answers, ["couldn't find the line"]);
  assert.deepEqual(
    h.edits.map((e) => e.text),
    ["⚠️ That line is gone from the note."],
  );
  assert.deepEqual(h.updates, []);
});

test("declining changes nothing", async () => {
  const h = harness();
  await h.flow.handleTap(h.ctx, ["n", "abcd1234"]);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.moves, []);
  assert.deepEqual(
    h.edits.map((e) => e.text),
    ["🚫 Kept in the journal."],
  );
});

test("a purged or deleted jot answers gone whatever was tapped", async () => {
  for (const jot of [null, { status: "deleted" }]) {
    for (const action of ["y", "n"]) {
      const h = harness({ jot });
      await h.flow.handleTap(h.ctx, [action, "abcd1234"]);
      assert.deepEqual(h.answers, ["gone"]);
      assert.deepEqual(
        h.edits.map((e) => e.text),
        ["That jot is gone."],
      );
      assert.deepEqual(h.moves, []);
      assert.deepEqual(h.updates, []);
      assert.deepEqual(h.marked, []);
    }
  }
});

test("callback data with no jot id never looks a jot up", async () => {
  for (const args of [["y"], []]) {
    const h = harness();
    await h.flow.handleTap(h.ctx, args);
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(
      h.edits.map((e) => e.text),
      ["That jot is gone."],
    );
  }
});

test("a failed card edit does not undo a move that already happened", async () => {
  const h = harness();
  h.ctx.editMessageText = async () => {
    throw new Error("message is not modified");
  };
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  assert.equal(h.updates.length, 2);
  await h.flow.handleTap(h.ctx, ["n", "abcd1234"]);
  assert.deepEqual(h.answers, ["moved to TIL", "kept in the journal"]);
});

test("a failing vault write answers the tap, changes nothing and keeps the card for a retry", async () => {
  const h = harness({ moveFails: true });
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  assert.deepEqual(h.answers, ["couldn't move it, tap again to retry"]);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.edits, []);
});

test("an expired callback query rejects after the move, and the card is not settled", async () => {
  const accepted = harness({ answerFails: true });
  await assert.rejects(
    () => accepted.flow.handleTap(accepted.ctx, ["y", "abcd1234"]),
    /too old/,
  );
  assert.equal(accepted.updates.length, 2);
  assert.deepEqual(accepted.edits, []);

  const declined = harness({ answerFails: true });
  await assert.rejects(
    () => declined.flow.handleTap(declined.ctx, ["n", "abcd1234"]),
    /too old/,
  );
  assert.deepEqual(declined.edits, []);
});

test("tapping accept twice against a real note keeps one copy of the line in the TIL section", async () => {
  let note = [
    "## Journal",
    "- _10:00:00 ::_ first ^aaaaaaaa",
    "- _10:01:00 ::_ learned x ^abcd1234",
    "## TIL",
    "- ",
  ].join("\n");
  const h = harness({
    move: async (_path, anchor) => {
      const out = moveAnchorLine(note, anchor, "TIL");
      if ("missing" in out) return "no-line";
      note = out.note;
      return "moved";
    },
  });
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
  assert.equal(note.split("^abcd1234").length - 1, 1);
  assert.ok(note.indexOf("^abcd1234") > note.indexOf("## TIL"));
  assert.ok(h.updates.every(([, patch]) => patch.section === "til"));
});

test("a fresh flow can answer a card another instance sent, since the card carries only the jot id", async () => {
  const first = harness();
  await first.flow.ask("abcd1234", "sqlite has WAL");
  const second = new TilFlow(
    { api: {} } as any,
    first.repo as any,
    first.obsidian as any,
  );
  await second.handleTap(first.ctx, ["y", "abcd1234"]);
  assert.deepEqual(first.moves, [
    ["notes/daily notes/2026-08-16.md", "abcd1234"],
  ]);
});

test("every outcome clears the card's buttons", async () => {
  const outcomes: [string, Parameters<typeof harness>[0]][] = [
    ["y", {}],
    ["y", { moved: "no-line" }],
    ["y", { moved: "no-heading" }],
    ["y", { jot: null }],
    ["n", {}],
  ];
  for (const [action, over] of outcomes) {
    const h = harness(over);
    await h.flow.handleTap(h.ctx, [action, "abcd1234"]);
    assert.deepEqual(h.edits[0]?.markup.inline_keyboard.flat(), []);
  }
});

test("the card goes to the owner with both buttons carrying the jot id", async () => {
  const h = harness();
  await h.flow.ask("abcd1234", "sqlite has WAL");
  const sent = h.sends[0]!;
  assert.equal(sent.chat, 1);
  assert.equal(sent.opts.parse_mode, "HTML");
  assert.match(sent.text, /<blockquote>sqlite has WAL<\/blockquote>/);
  const buttons = sent.opts.reply_markup.inline_keyboard.flat();
  assert.deepEqual(
    buttons.map((b: any) => [b.text, b.callback_data]),
    [
      ["✅ Move to TIL", "ti:y:abcd1234"],
      ["🚫 Keep in Journal", "ti:n:abcd1234"],
    ],
  );
});

test("the jot's text is escaped so it cannot close the quote early", async () => {
  const h = harness();
  await h.flow.ask("abcd1234", '<b>x</b> & "q" </blockquote><script>');
  const { text } = h.sends[0]!;
  assert.ok(!text.includes("<b>x"));
  assert.ok(!text.includes("<script>"));
  assert.equal(text.split("</blockquote>").length - 1, 1);
});

test("a jot over Telegram's cap is quoted truncated, so the card still goes out and is marked", async () => {
  const h = harness({ sendFails: (text) => text.length > 4096 });
  await h.flow.ask("abcd1234", "x".repeat(10_000));
  assert.equal(h.sends.length, 1);
  assert.ok(h.sends[0]!.text.length < 4096);
  assert.match(h.sends[0]!.text, /…<\/blockquote>$/);
  assert.deepEqual(h.marked, ["abcd1234"]);
});

test("a worst-case escaped jot still fits in one message", async () => {
  const h = harness({ sendFails: (text) => text.length > 4096 });
  await h.flow.ask("abcd1234", "&".repeat(10_000));
  assert.equal(h.sends.length, 1);
});

test("the jot is marked as asked only after the card was sent", async () => {
  const ok = harness();
  await ok.flow.ask("abcd1234", "sqlite has WAL");
  assert.deepEqual(ok.marked, ["abcd1234"]);

  const failed = harness({ sendFails: () => true });
  await failed.flow.ask("abcd1234", "sqlite has WAL");
  assert.deepEqual(failed.marked, []);
});

test("the move uses the jot's own note, even when the tap comes the next day", async () => {
  for (const notePath of [
    "notes/daily notes/2026-08-16.md",
    "notes/daily notes/2026-12-31.md",
  ]) {
    const h = harness({ jot: { note_path: notePath } });
    await h.flow.handleTap(h.ctx, ["y", "abcd1234"]);
    assert.deepEqual(h.moves, [[notePath, "abcd1234"]]);
  }
});
