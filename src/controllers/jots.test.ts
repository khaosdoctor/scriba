import assert from "node:assert/strict";
import { test } from "node:test";
import { moveAnchorLine } from "../core.ts";
import { JotController } from "./jots.ts";

type Moved = "moved" | "no-line" | "no-heading";

function setup(
  over: {
    moved?: Moved;
    sendFails?: (text: string) => boolean;
    jot?: object | null;
    followers?: { id: string }[];
    moveFails?: boolean;
    move?: (path: string, anchor: string) => Promise<Moved>;
  } = {},
) {
  const updates: [string, unknown][] = [];
  const marked: string[] = [];
  const lookups: string[] = [];
  const moves: [string, string][] = [];
  const sends: { text: string; opts: any }[] = [];
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
    updateJot: async (id: string, patch: unknown) =>
      void updates.push([id, patch]),
    markTilOffered: async (id: string) => void marked.push(id),
  };
  const obsidian = {
    moveToTil: async (path: string, anchor: string) => {
      moves.push([path, anchor]);
      if (over.moveFails) throw new Error("obsidian is down");
      return over.move ? over.move(path, anchor) : (over.moved ?? "moved");
    },
  };
  const notifier = {
    send: async (text: string, opts: unknown) => {
      if (over.sendFails?.(text)) throw new Error("telegram rejected it");
      sends.push({ text, opts });
      return 1;
    },
  };
  const deps = { repo, obsidian, notifier } as never;
  return {
    jots: new JotController(deps),
    deps,
    updates,
    marked,
    lookups,
    moves,
    sends,
  };
}

test("accepting moves the line and follows it with the leader's and followers' section", async () => {
  const h = setup();
  assert.equal(await h.jots.answerTil("abcd1234", true), "moved");
  assert.deepEqual(h.updates, [
    ["abcd1234", { section: "til" }],
    ["f0000001", { section: "til" }],
  ]);
});

test("a jot with no followers gets exactly one section update", async () => {
  const h = setup({ followers: [] });
  await h.jots.answerTil("abcd1234", true);
  assert.deepEqual(h.updates, [["abcd1234", { section: "til" }]]);
});

test("a note with no TIL heading is left alone", async () => {
  const h = setup({ moved: "no-heading" });
  assert.equal(await h.jots.answerTil("abcd1234", true), "no-heading");
  assert.deepEqual(h.updates, []);
});

test("a line that is gone from the note changes nothing", async () => {
  const h = setup({ moved: "no-line" });
  assert.equal(await h.jots.answerTil("abcd1234", true), "no-line");
  assert.deepEqual(h.updates, []);
});

test("declining changes nothing", async () => {
  const h = setup();
  assert.equal(await h.jots.answerTil("abcd1234", false), "kept");
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.moves, []);
});

test("a purged or deleted jot is gone whatever was tapped", async () => {
  for (const jot of [null, { status: "deleted" }]) {
    for (const accept of [true, false]) {
      const h = setup({ jot });
      assert.equal(await h.jots.answerTil("abcd1234", accept), "gone");
      assert.deepEqual(h.moves, []);
      assert.deepEqual(h.updates, []);
      assert.deepEqual(h.marked, []);
    }
  }
});

test("callback data with no jot id never looks a jot up", async () => {
  const h = setup();
  assert.equal(await h.jots.answerTil(undefined, true), "gone");
  assert.deepEqual(h.lookups, []);
});

test("a failing vault write changes nothing and reports a failed move", async () => {
  const h = setup({ moveFails: true });
  assert.equal(await h.jots.answerTil("abcd1234", true), "failed");
  assert.deepEqual(h.updates, []);
});

test("tapping accept twice against a real note keeps one copy of the line in the TIL section", async () => {
  let note = [
    "## Journal",
    "- _10:00:00 ::_ first ^aaaaaaaa",
    "- _10:01:00 ::_ learned x ^abcd1234",
    "## TIL",
    "- ",
  ].join("\n");
  const h = setup({
    move: async (_path, anchor) => {
      const out = moveAnchorLine(note, anchor, "TIL");
      if ("missing" in out) return "no-line";
      note = out.note;
      return "moved";
    },
  });
  await h.jots.answerTil("abcd1234", true);
  await h.jots.answerTil("abcd1234", true);
  assert.equal(note.split("^abcd1234").length - 1, 1);
  assert.ok(note.indexOf("^abcd1234") > note.indexOf("## TIL"));
  assert.ok(h.updates.every(([, patch]) => (patch as any).section === "til"));
});

test("a fresh controller can answer a card another instance sent, since the card carries only the jot id", async () => {
  const first = setup();
  await first.jots.askTil("abcd1234", "sqlite has WAL");
  const second = new JotController(first.deps);
  assert.equal(await second.answerTil("abcd1234", true), "moved");
  assert.deepEqual(first.moves, [
    ["notes/daily notes/2026-08-16.md", "abcd1234"],
  ]);
});

test("the move uses the jot's own note, even when the tap comes the next day", async () => {
  for (const notePath of [
    "notes/daily notes/2026-08-16.md",
    "notes/daily notes/2026-12-31.md",
  ]) {
    const h = setup({ jot: { note_path: notePath } });
    await h.jots.answerTil("abcd1234", true);
    assert.deepEqual(h.moves, [[notePath, "abcd1234"]]);
  }
});

test("the card is HTML with both buttons carrying the jot id", async () => {
  const h = setup();
  await h.jots.askTil("abcd1234", "sqlite has WAL");
  const sent = h.sends[0]!;
  assert.equal(sent.opts.html, true);
  assert.match(sent.text, /<blockquote>sqlite has WAL<\/blockquote>/);
  assert.deepEqual(
    sent.opts.keyboard.inline_keyboard
      .flat()
      .map((b: any) => [b.text, b.callback_data]),
    [
      ["✅ Move to TIL", "ti:y:abcd1234"],
      ["🚫 Keep in Journal", "ti:n:abcd1234"],
    ],
  );
});

test("the jot's text is escaped so it cannot close the quote early", async () => {
  const h = setup();
  await h.jots.askTil("abcd1234", '<b>x</b> & "q" </blockquote><script>');
  const { text } = h.sends[0]!;
  assert.ok(!text.includes("<b>x"));
  assert.ok(!text.includes("<script>"));
  assert.equal(text.split("</blockquote>").length - 1, 1);
});

test("a jot over Telegram's cap is quoted truncated, so the card still goes out and is marked", async () => {
  const h = setup({ sendFails: (text) => text.length > 4096 });
  await h.jots.askTil("abcd1234", "x".repeat(10_000));
  assert.equal(h.sends.length, 1);
  assert.ok(h.sends[0]!.text.length < 4096);
  assert.match(h.sends[0]!.text, /…<\/blockquote>$/);
  assert.deepEqual(h.marked, ["abcd1234"]);
});

test("a worst-case escaped jot still fits in one message", async () => {
  const h = setup({ sendFails: (text) => text.length > 4096 });
  await h.jots.askTil("abcd1234", "&".repeat(10_000));
  assert.equal(h.sends.length, 1);
});

test("the jot is marked as asked only after the card was sent", async () => {
  const ok = setup();
  await ok.jots.askTil("abcd1234", "sqlite has WAL");
  assert.deepEqual(ok.marked, ["abcd1234"]);

  const failed = setup({ sendFails: () => true });
  await failed.jots.askTil("abcd1234", "sqlite has WAL");
  assert.deepEqual(failed.marked, []);
});
