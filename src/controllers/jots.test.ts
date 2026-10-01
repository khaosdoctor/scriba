import assert from "node:assert/strict";
import { test } from "node:test";
import { moveAnchorLine, placeholderLine } from "../lib/note.ts";
import { plainDate, plainTime, previousDate } from "../lib/time.ts";
import type { IntakeInput, Jot } from "../models/domain.ts";
import { Repository } from "../repositories/index.ts";
import { removeDb, sampleJot, tempDbPath } from "../test/sqlite.ts";
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

// --- intake ---

const NOW = Date.UTC(2026, 7, 16, 10, 0, 0);
const today = plainDate(NOW);
const notePath = `notes/daily notes/${today}.md`;

const leader = (over: Partial<Jot> = {}): Jot =>
  sampleJot("aaaaaaaa", {
    note_path: notePath,
    time: plainTime(NOW - 2000),
    raw_text: "earlier",
    received_at: NOW - 2000,
    updated_at: NOW - 2000,
    ...over,
  });

type IntakeFakes = {
  prev?: Jot;
  jot?: Jot;
  jotId?: string;
  unsquash?: boolean;
  appendFails?: boolean;
  realRepo?: Repository;
  /** Offer the newest inserted jot back as the still-pending one, like the real repo. */
  chain?: boolean;
};

function intakeSetup(over: IntakeFakes = {}) {
  const inserted: Jot[] = [];
  const mapped: [number, string][] = [];
  const lookups: [string, string][] = [];
  const appended: [string, string, string | undefined][] = [];
  const ensured: string[] = [];
  const queued: string[] = [];
  const reacts: [number, string][] = [];
  const notices: string[] = [];
  const repo = over.realRepo ?? {
    insertJot: async (j: Jot) => void inserted.push(j),
    mapMessage: async (m: number, id: string) => void mapped.push([m, id]),
    lastPendingEnrichableJot: async (notePath: string, section: string) => {
      lookups.push([notePath, section]);
      return over.prev ?? (over.chain ? inserted.at(-1) : undefined);
    },
    jotForMessage: async () => over.jotId,
    getJot: async () => over.jot,
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
  const notifier = {
    react: async (messageId: number, emoji: string) =>
      void reacts.push([messageId, emoji]),
    notify: async (text: string) => void notices.push(text),
  };
  const jots = new JotController({
    repo,
    obsidian,
    notifier,
    queue: { add: (ids: string[]) => void queued.push(...ids) },
    squashWindowMs: 15_000,
  } as never);
  const input = (over: Partial<IntakeInput> = {}): IntakeInput => ({
    kind: "text",
    messageId: 77,
    sentAt: NOW,
    rawText: null,
    ...over,
  });
  return {
    jots,
    inserted,
    mapped,
    lookups,
    appended,
    ensured,
    queued,
    reacts: () => reacts.map(([, emoji]) => emoji),
    reactedTo: () => reacts.map(([messageId]) => messageId),
    notices,
    intake: (over: Partial<IntakeInput> = {}) => jots.intake(input(over)),
  };
}

test("a TIL text jot is stored stripped, in the til section, and written under it", async () => {
  const h = intakeSetup();
  await h.intake({ rawText: "TIL: sqlite has WAL mode" });
  const row = h.inserted[0]!;
  assert.equal(row.section, "til");
  assert.equal(row.raw_text, "sqlite has WAL mode");
  assert.deepEqual(h.lookups, [[notePath, "til"]]);
  assert.deepEqual(h.appended, [
    [today, placeholderLine(row.time, row.id), "til"],
  ]);
  assert.deepEqual(h.mapped, [[77, row.id]]);
  assert.deepEqual(h.queued, [row.id]);
  assert.deepEqual(h.reacts(), ["✍"]);
  assert.deepEqual(h.reactedTo(), [77]);
});

test("a plain text jot stays in the journal section untouched", async () => {
  const h = intakeSetup();
  await h.intake({ rawText: "bought milk" });
  const row = h.inserted[0]!;
  assert.equal(row.section, "journal");
  assert.equal(row.raw_text, "bought milk");
  assert.deepEqual(h.lookups, [[notePath, "journal"]]);
  assert.equal(h.appended[0]?.[2], "journal");
});

test("only text jots are checked for the TIL marker", async () => {
  const audio = intakeSetup();
  await audio.intake({ kind: "audio", fileId: "f1", rawText: "TIL something" });
  assert.equal(audio.inserted[0]?.section, "journal");
  assert.equal(audio.inserted[0]?.raw_text, "TIL something");

  const image = intakeSetup();
  await image.intake({ kind: "image", fileId: "f2", rawText: "TIL: a cat" });
  assert.equal(image.inserted[0]?.section, "journal");
  assert.equal(image.inserted[0]?.raw_text, "TIL: a cat");
});

test("known limitation: 'til' the English word sends a jot to the TIL section", async () => {
  for (const [text, stored] of [
    ["til noon I slept", "noon I slept"],
    ["Til midnight", "midnight"],
    ["til 5pm", "5pm"],
  ] as const) {
    const h = intakeSetup();
    await h.intake({ rawText: text });
    assert.equal(h.inserted[0]?.section, "til", text);
    assert.equal(h.inserted[0]?.raw_text, stored, text);
    assert.equal(h.appended[0]?.[2], "til", text);
  }
});

test("a jot with no text at all is a journal jot with a null raw_text, a captionless one keeps the empty caption", async () => {
  for (const kind of ["text", "video"] as const) {
    const none = intakeSetup();
    await none.intake({ kind, fileId: "f1" });
    assert.equal(none.inserted[0]?.section, "journal", kind);
    assert.equal(none.inserted[0]?.raw_text, null, kind);
  }

  const caption = intakeSetup();
  await caption.intake({ kind: "image", fileId: "f2", rawText: "" });
  assert.equal(caption.inserted[0]?.raw_text, "");
});

test("a TIL jot squashes into a pending TIL leader and writes no placeholder", async () => {
  const h = intakeSetup({ prev: leader({ section: "til" }) });
  await h.intake({ rawText: "TIL: second fact" });
  const row = h.inserted[0]!;
  assert.equal(row.anchor, "aaaaaaaa");
  assert.equal(row.section, "til");
  assert.deepEqual(h.reacts(), ["🤝"]);
  assert.deepEqual(h.appended, []);
  assert.deepEqual(h.ensured, []);
  assert.deepEqual(h.queued, [row.id]);
});

test("a TIL leader outside the squash window is not joined", async () => {
  const h = intakeSetup({
    prev: leader({ section: "til", received_at: NOW - 60_000 }),
  });
  await h.intake({ rawText: "TIL: later fact" });
  const row = h.inserted[0]!;
  assert.equal(row.anchor, row.id);
  assert.deepEqual(h.reacts(), ["✍"]);
  assert.equal(h.appended[0]?.[2], "til");
});

test("a voice jot squashes into a journal leader and keeps the journal section", async () => {
  const h = intakeSetup({ prev: leader() });
  await h.intake({ kind: "audio", fileId: "f1" });
  assert.equal(h.inserted[0]?.anchor, "aaaaaaaa");
  assert.equal(h.inserted[0]?.section, "journal");
  assert.deepEqual(h.lookups, [[notePath, "journal"]]);
});

test("image and video jots never look for a squash leader", async () => {
  for (const kind of ["image", "video"] as const) {
    const h = intakeSetup({ prev: leader() });
    await h.intake({ kind, fileId: "f1", rawText: "" });
    assert.deepEqual(h.lookups, [], kind);
    assert.equal(h.inserted[0]?.section, "journal", kind);
    assert.equal(h.inserted[0]?.anchor, h.inserted[0]?.id, kind);
  }
});

test("a failed placeholder write still leaves the til row mapped and unqueued", async () => {
  const h = intakeSetup({ appendFails: true });
  await assert.rejects(
    () => h.intake({ rawText: "TIL: x y" }),
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
    const h = intakeSetup({ realRepo: repo });
    await h.intake({ rawText: "TIL: x y" });
    const til = await repo.getJot((await repo.jotForMessage(77))!);
    assert.equal(til?.section, "til");
    assert.equal(til?.anchor, til?.id);
    assert.deepEqual(h.reacts(), ["✍"]);

    // and the other way round: a plain jot after the TIL jot skips it and rejoins the
    // journal run it left off
    await h.intake({ rawText: "plain", messageId: 78, sentAt: NOW + 1000 });
    const plain = await repo.getJot((await repo.jotForMessage(78))!);
    assert.equal(plain?.section, "journal");
    assert.equal(plain?.anchor, "aaaaaaaa");
    assert.deepEqual(h.reacts(), ["✍", "🤝"]);
  } finally {
    await repo.close();
    await removeDb(dbPath);
  }
});

// --- filing under another day (the follow-up after the nightly rating) ---

const rated = previousDate(NOW);
const ratedPath = `notes/daily notes/${rated}.md`;

test("a jot for a past day is filed as that day's last entry", async () => {
  const h = intakeSetup();
  await h.intake({ rawText: "Quiet day", day: rated });
  assert.equal(h.inserted.length, 1);
  const row = h.inserted[0]!;
  assert.equal(row.note_path, ratedPath);
  assert.equal(row.time, "23:59:59");
  assert.equal(row.section, "journal");
  assert.equal(row.raw_text, "Quiet day");
  assert.equal(row.kind, "text");
  assert.deepEqual(h.ensured, [rated]);
});

test("a TIL-prefixed answer for a past day goes into that day's til section", async () => {
  const h = intakeSetup();
  await h.intake({ rawText: "TIL: owls", day: rated });
  const row = h.inserted[0]!;
  assert.equal(row.section, "til");
  assert.equal(row.raw_text, "owls");
  assert.equal(row.note_path, ratedPath);
  assert.equal(h.appended[0]?.[2], "til");
});

test("two entries for one past day never squash, even seconds apart", async () => {
  const h = intakeSetup({ chain: true });
  await h.intake({ rawText: "one", day: rated });
  await h.intake({ rawText: "two", day: rated, sentAt: NOW + 2000 });
  assert.equal(h.inserted.length, 2);
  for (const row of h.inserted) assert.equal(row.anchor, row.id);
  assert.deepEqual(h.lookups, []);
  assert.deepEqual(h.reacts(), ["✍", "✍"]);
});

test("an entry for the day it is sent on keeps its real time and skips squashing", async () => {
  const h = intakeSetup({ chain: true });
  await h.intake({ rawText: "now", day: today });
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
      const h = intakeSetup();
      await h.intake({ rawText: "x", day, sentAt: next.getTime() });
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

// --- the merge opt-out ---

const tilJot = (over: Partial<Jot> = {}) =>
  leader({ section: "til", status: "done", ...over });

test("an un-squashed TIL follower is re-appended under the til section", async () => {
  const follower = tilJot({
    id: "bbbbbbbb",
    anchor: "aaaaaaaa",
    status: "pending",
  });
  const h = intakeSetup({ jotId: "bbbbbbbb", jot: follower });
  await h.jots.optOutOfSquash(77);
  assert.deepEqual(h.appended, [
    [
      plainDate(follower.received_at),
      placeholderLine(follower.time, "bbbbbbbb"),
      "til",
    ],
  ]);
  assert.deepEqual(h.reacts(), ["✍"]);
  assert.deepEqual(h.reactedTo(), [77]);
});

test("an un-squashed journal follower is re-appended under the journal section", async () => {
  const follower = leader({ id: "bbbbbbbb", anchor: "aaaaaaaa" });
  const h = intakeSetup({ jotId: "bbbbbbbb", jot: follower });
  await h.jots.optOutOfSquash(77);
  assert.equal(h.appended[0]?.[2], "journal");
});

test("the opt-out writes the placeholder on the jot's own day, not today's", async () => {
  const received = Date.UTC(2020, 0, 2, 23, 59, 0);
  const follower = tilJot({
    id: "bbbbbbbb",
    anchor: "aaaaaaaa",
    received_at: received,
  });
  const h = intakeSetup({ jotId: "bbbbbbbb", jot: follower });
  await h.jots.optOutOfSquash(77);
  assert.deepEqual(h.ensured, [plainDate(received)]);
  assert.equal(h.appended[0]?.[0], plainDate(received));
  assert.notEqual(plainDate(received), today);
});

test("the merge opt-out ignores an unknown message and a leader, and reports a late tap", async () => {
  const follower = tilJot({ id: "bbbbbbbb", anchor: "aaaaaaaa" });

  const unknown = intakeSetup({ jotId: undefined });
  await unknown.jots.optOutOfSquash(77);
  const isLeader = intakeSetup({ jotId: "aaaaaaaa", jot: tilJot() });
  await isLeader.jots.optOutOfSquash(77);
  for (const h of [unknown, isLeader])
    assert.deepEqual([h.appended, h.notices, h.reacts()], [[], [], []]);

  const late = intakeSetup({
    jotId: "bbbbbbbb",
    jot: follower,
    unsquash: false,
  });
  await late.jots.optOutOfSquash(77);
  assert.deepEqual(late.appended, []);
  assert.match(late.notices[0]!, /too late/);
  assert.deepEqual(late.reacts(), []);
});

// --- the voice-fix pick ---

test("a voice-fix pick is claimed once: the second claim and an unknown jot get nothing", () => {
  const h = setup();
  const choices: string[] = [];
  (h.jots as any).voiceFixPending.set("abcd1234", (c: string) =>
    choices.push(c),
  );
  const settle = h.jots.pickVoiceFix("abcd1234", "proposed");
  assert.ok(settle);
  assert.deepEqual(choices, []);
  settle();
  assert.deepEqual(choices, ["proposed"]);
  assert.equal(h.jots.pickVoiceFix("abcd1234", "original"), undefined);
  assert.equal(h.jots.pickVoiceFix("ffffffff", "original"), undefined);
});
