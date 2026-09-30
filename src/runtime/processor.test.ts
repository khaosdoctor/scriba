import assert from "node:assert/strict";
import { test } from "node:test";
import { insertJournalLine } from "../core.ts";
import type { Jot } from "../db.ts";
import { MAX_ATTEMPTS } from "../db.ts";
import { ModelsDownError } from "../services/enrich.ts";
import { HELD as HELD_MARKER, JotProcessor } from "./processor.ts";

/** Status messages the bot was asked to post, with the buttons each one carried. */
type Posted = { id: string; html: string; opts: any };

const jot = (over: Partial<Jot> = {}): Jot =>
  ({
    id: "abcd1234",
    anchor: "abcd1234",
    kind: "text",
    status: "processing",
    attempts: 0,
    raw_text: "a thought",
    transcript: null,
    proposed_text: null,
    section: "journal",
    asset_path: null,
    file_id: null,
    note_path: "notes/daily notes/2026-08-16.md",
    time: "10:00:00",
    error: null,
    ...over,
  }) as Jot;

/** A processor whose collaborators only record what they were asked to do. The note write
 *  throws, which is the give-up path's own escape hatch — it keeps the stubs to the parts
 *  under test. */
function harness(
  over: {
    followers?: Jot[];
    detection?: string;
    priorDrafts?: number;
    tilAsked?: boolean;
  } = {},
) {
  const posted: Posted[] = [];
  const reactions: [string, string][] = [];
  const updates: [string, any][] = [];
  const repo = {
    updateJot: async (id: string, patch: any) => void updates.push([id, patch]),
    groupFollowers: async () => over.followers ?? [],
    getSetting: async () => over.detection,
    taskDraftsForJot: async () => over.priorDrafts ?? 0,
    tilOffered: async () => over.tilAsked ?? false,
  };
  const obsidian = {
    ensureDailyNote: async () => {
      throw new Error("obsidian is down");
    },
  };
  const bot = {
    status: async (id: string, html: string, opts?: any) => {
      posted.push({ id, html, opts });
    },
    react: async (id: string, state: string) =>
      void reactions.push([id, state]),
    deleteStatus: async () => {},
    onJotDone: async () => {},
  };
  const processor: any = new JotProcessor(
    repo as any,
    obsidian as any,
    {} as any,
    {} as any,
    {} as any,
    bot as any,
  );
  return { processor, posted, reactions, updates };
}

/** Which buttons a status message asked for. */
const buttons = (p: Posted | undefined) => ({
  retry: !!p?.opts?.retry,
  discard: !!p?.opts?.discard,
});

test("a transient failure says so on the jot's message, with both buttons", async () => {
  const { processor, posted, reactions, updates } = harness();
  await processor.fail(jot(), new Error("fetch failed"));

  // It stays in the retry cycle…
  assert.deepEqual(updates, [
    ["abcd1234", { status: "failed", attempts: 1, error: "fetch failed" }],
  ]);
  assert.deepEqual(reactions, [["abcd1234", "retrying"]]);
  // …and the message says that instead of sitting on "Weaving it into your journal…".
  const msg = posted.at(-1);
  assert.equal(msg?.id, "abcd1234");
  assert.match(msg!.html, /didn't go through \(attempt 1 of \d+\)/);
  assert.match(msg!.html, /fetch failed/);
  assert.deepEqual(buttons(msg), { retry: true, discard: true });
});

test("giving up posts the same pair of buttons", async () => {
  const { processor, posted, reactions } = harness();
  await processor.fail(jot(), new Error("nonsense the model produced"));

  assert.deepEqual(reactions, [["abcd1234", "failed"]]);
  const msg = posted.at(-1);
  assert.match(msg!.html, /Gave up on a text jot \(unrecoverable error\)/);
  assert.deepEqual(buttons(msg), { retry: true, discard: true });
});

test("an out-of-tries jot gives up rather than promising another go", async () => {
  const { processor, posted } = harness();
  await processor.fail(
    jot({ attempts: MAX_ATTEMPTS - 1 }),
    new Error("timeout"),
  );
  const msg = posted.at(-1);
  assert.match(msg!.html, new RegExp(`no luck after ${MAX_ATTEMPTS} tries`));
  assert.deepEqual(buttons(msg), { retry: true, discard: true });
});

test("a squashed give-up still names the whole burst", async () => {
  const { processor, posted } = harness({
    followers: [jot({ id: "ffff0001", anchor: "abcd1234" })],
  });
  await processor.fail(jot(), new Error("bad input"));
  assert.match(posted.at(-1)!.html, /2 jots squashed into one entry/);
});

test("a failed status message that won't send doesn't take the batch down", async () => {
  const { processor } = harness();
  (processor as any).bot.status = async () => {
    throw new Error("telegram 502");
  };
  // fail() runs inside processJot's catch — a throw here would abandon the other jots.
  await processor.fail(jot(), new Error("fetch failed"));
});

// --- tasks spotted in a jot ---

const detected = [
  { description: "Call the vet tomorrow", type: "personal" },
  { description: "Answer the RFC", due: "next friday", type: "work" },
];

test("detected tasks become drafts dated from the jot's own day", async () => {
  const { processor } = harness();
  // The jot's note is 2026-08-16 (a Sunday), so "tomorrow" is the day after the entry —
  // not the day it happens to be processed.
  assert.deepEqual(await processor.tasksFrom(detected, jot()), [
    {
      description: "Call the vet",
      type: "personal",
      start: null,
      due: "2026-08-17",
    },
    {
      description: "Answer the RFC",
      type: "work",
      start: null,
      due: "2026-08-21",
    },
  ]);
});

test("detection can be switched off, and never asks about the same jot twice", async () => {
  const off = harness({ detection: "off" });
  assert.deepEqual(await off.processor.tasksFrom(detected, jot()), []);

  // A jot that already produced drafts was asked about once — /reprocess must not ask
  // again about tasks that were created, or dismissed, weeks ago.
  const asked = harness({ priorDrafts: 2 });
  assert.deepEqual(await asked.processor.tasksFrom(detected, jot()), []);

  const none = harness();
  assert.deepEqual(await none.processor.tasksFrom([], jot()), []);
  assert.deepEqual(await none.processor.tasksFrom(undefined, jot()), []);
});

test("a TIL card needs the enricher's read and passes every guard", async () => {
  assert.equal(await harness().processor.tilWanted(true, jot()), true);
  assert.equal(await harness().processor.tilWanted(false, jot()), false);
  // switched off from the menu
  const off = harness({ detection: "off" });
  assert.equal(await off.processor.tilWanted(true, jot()), false);
  // already a TIL jot (the prefix routed it there at intake)
  assert.equal(
    await harness().processor.tilWanted(true, jot({ section: "til" })),
    false,
  );
  // asked once already, so /reprocess stays quiet
  const asked = harness({ tilAsked: true });
  assert.equal(await asked.processor.tilWanted(true, jot()), false);
});

/** A processor driven through `processJot` end to end: a stateful jot table and note, an
 *  enricher that answers as told, and a bot that logs every call in order. */
function pipeline(
  over: {
    til?: boolean;
    tasks?: { description: string; type?: string }[];
    raw?: string;
    followers?: Jot[];
    writeFails?: boolean;
    section?: "journal" | "til";
  } = {},
) {
  const calls: string[] = [];
  const tilAsks: [string, string][] = [];
  const enriched: string[] = [];
  const offered = new Set<string>();
  const leader = jot({
    status: "pending",
    section: over.section ?? "journal",
    raw_text: over.raw ?? "a thought",
  } as Partial<Jot>);
  const jots = new Map<string, Jot>(
    [leader, ...(over.followers ?? [])].map((j) => [j.id, j]),
  );
  let note = `## Journal\n- _10:00:00 ::_ ⏳ ^${leader.id}`;
  const repo = {
    getJot: async (id: string) => jots.get(id),
    claim: async () => true,
    getSetting: async () => undefined,
    updateJot: async () => {},
    groupFollowers: async () => over.followers ?? [],
    stopwords: async () => new Set<string>(),
    rejections: async () => new Set<string>(),
    registeredLinks: async () => [],
    addPendingLink: async () => {},
    taskDraftsForJot: async () => 0,
    tilOffered: async (id: string) => offered.has(id),
    insertJot: async () => {},
  };
  const obsidian = {
    ensureDailyNote: async () => "",
    withNoteLock: async (_p: string, fn: () => Promise<unknown>) => fn(),
    readNote: async () => note,
    writeNote: async (_p: string, c: string) => {
      if (over.writeFails) throw new Error("obsidian is down");
      note = c;
      calls.push("write");
    },
    appendJournalLine: async () => {
      if (over.writeFails) throw new Error("obsidian is down");
    },
  };
  const enricher = {
    available: () => true,
    enrich: async (input: { text: string }) => {
      enriched.push(input.text);
      return {
        text: "Learned that X",
        ambiguous: [],
        tasks: over.tasks ?? [],
        til: over.til ?? false,
        usage: { input: 0, output: 0 },
      };
    },
  };
  const bot = {
    typing: async () => {},
    status: async (_id: string, _html: string, opts?: { undo?: boolean }) =>
      void calls.push(opts?.undo ? "status:done" : "status"),
    react: async () => {},
    deleteStatus: async () => {},
    askLink: async () => {},
    askTask: async (d: { description: string }) =>
      void calls.push(`askTask:${d.description}`),
    askTil: async (id: string, text: string) => {
      tilAsks.push([id, text]);
      calls.push("askTil");
    },
    onJotDone: async () => void calls.push("onJotDone"),
  };
  const processor: any = new JotProcessor(
    repo as any,
    obsidian as any,
    {} as any,
    enricher as any,
    { list: () => [] } as any,
    bot as any,
  );
  return {
    processor,
    calls,
    tilAsks,
    enriched,
    offered,
    leaderId: leader.id,
    note: () => note,
  };
}

test("a jot the enricher read as a TIL gets its card after the entry is written and before the drain", async () => {
  const p = pipeline({ til: true });
  await p.processor.processJot(p.leaderId);
  assert.deepEqual(p.tilAsks, [[p.leaderId, "Learned that X"]]);
  const at = (c: string) => p.calls.indexOf(c);
  assert.ok(at("write") < at("status:done"));
  assert.ok(at("status:done") < at("askTil"));
  assert.ok(at("askTil") < at("onJotDone"));
});

test("no card when the enricher did not read it as a TIL", async () => {
  const p = pipeline({ til: false });
  await p.processor.processJot(p.leaderId);
  assert.deepEqual(p.tilAsks, []);
  assert.ok(p.calls.includes("status:done"));
  assert.ok(p.calls.includes("onJotDone"));
});

test("a blank jot never reaches the enricher or the card", async () => {
  for (const raw of ["", "   "]) {
    const p = pipeline({ til: true, raw });
    await p.processor.processJot(p.leaderId);
    assert.deepEqual(p.enriched, []);
    assert.deepEqual(p.tilAsks, []);
    assert.ok(p.calls.includes("status:done"));
  }
});

test("a jot whose note write fails gets no card", async () => {
  const p = pipeline({ til: true, writeFails: true });
  await p.processor.processJot(p.leaderId);
  assert.deepEqual(p.tilAsks, []);
});

test("a task card comes before the TIL card, both before the drain", async () => {
  const p = pipeline({
    til: true,
    tasks: [{ description: "book flights", type: "personal" }],
  });
  await p.processor.processJot(p.leaderId);
  const at = (c: string) => p.calls.indexOf(c);
  assert.ok(at("askTask:book flights") < at("askTil"));
  assert.ok(at("askTil") < at("onJotDone"));
  assert.equal(p.tilAsks[0]?.[0], p.leaderId);
});

test("a squashed burst asks once, for the leader, on the leader's section", async () => {
  const follower = jot({
    id: "f0000001",
    anchor: "abcd1234",
    status: "pending",
    raw_text: "and more",
    section: "til",
  } as Partial<Jot>);
  const p = pipeline({ til: true, followers: [follower] });
  await p.processor.processJot(p.leaderId);
  assert.deepEqual(p.tilAsks, [[p.leaderId, "Learned that X"]]);
  assert.match(p.enriched[0]!, /a thought/);
  assert.match(p.enriched[0]!, /and more/);
});

test("a TIL jot is never offered the card", async () => {
  const p = pipeline({ til: true, section: "til" });
  await p.processor.processJot(p.leaderId);
  assert.deepEqual(p.tilAsks, []);
});

test("a reprocess after the card was sent does not ask again", async () => {
  const p = pipeline({ til: true });
  await p.processor.processJot(p.leaderId);
  p.offered.add(p.leaderId); // what TilFlow.ask does once the card is out
  await p.processor.processJot(p.leaderId);
  assert.equal(p.tilAsks.length, 1);
});

test("every model down: the jot goes back to pending, no attempt charged, one held notice", async () => {
  const { processor, posted, updates } = harness();
  await processor.fail(jot(), new ModelsDownError(new Error("overloaded 529")));

  assert.deepEqual(updates, [
    ["abcd1234", { status: "pending" }],
    ["abcd1234", { error: HELD_MARKER }],
  ]);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.html, /Every enrichment model is down/);
  assert.deepEqual(buttons(posted[0]), { retry: false, discard: true });

  // a sweep that finds it still held says nothing more
  await processor.hold(jot({ error: HELD_MARKER }));
  assert.equal(posted.length, 1);
});

test("a held notice that couldn't be sent isn't marked, so the next sweep tries again", async () => {
  const { processor, updates } = harness();
  processor.bot.status = async () => {
    throw new Error("telegram 502");
  };
  await processor.hold(jot());
  assert.deepEqual(updates, []);
});

/** A processor over an in-memory note, with appends routed through the real
 *  insertJournalLine the way ObsidianClient does it. */
function noteHarness(note: string) {
  const state = { note, writes: 0, appended: [] as [string, string, string][] };
  const obsidian = {
    ensureDailyNote: async () => "",
    withNoteLock: async (_p: string, fn: () => Promise<unknown>) => fn(),
    readNote: async () => state.note,
    writeNote: async (_p: string, content: string) => {
      state.writes++;
      state.note = content;
    },
    appendJournalLine: async (date: string, line: string, section: string) => {
      state.appended.push([date, line, section]);
      state.note = insertJournalLine(
        state.note,
        section === "til" ? "TIL" : "Journal",
        line,
      );
    },
  };
  const processor: any = new JotProcessor(
    {} as any,
    obsidian as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { processor, state };
}

const LINE = "- _10:00:00 ::_ hello ^abcd1234";

test("writeLine appends a TIL jot with the til section when its anchor is gone", async () => {
  const { processor, state } = noteHarness("## Journal\n- a ^aaaaaaaa\n");
  await processor.writeLine(jot({ section: "til" }), LINE);
  assert.deepEqual(state.appended, [["2026-08-16", LINE, "til"]]);
  assert.equal(state.writes, 0);
});

test("writeLine appends a journal jot with the journal section when its anchor is gone", async () => {
  const { processor, state } = noteHarness("## Journal\n- a ^aaaaaaaa\n");
  await processor.writeLine(jot({ section: "journal" }), LINE);
  assert.deepEqual(state.appended, [["2026-08-16", LINE, "journal"]]);
});

test("writeLine replaces a TIL line in place and never appends", async () => {
  const { processor, state } = noteHarness(
    "## Journal\n- a ^aaaaaaaa\n## TIL\n- _10:00:00 ::_ ⏳ ^abcd1234\n## Log\n",
  );
  await processor.writeLine(jot({ section: "til" }), LINE);
  assert.equal(
    state.note,
    `## Journal\n- a ^aaaaaaaa\n## TIL\n${LINE}\n## Log\n`,
  );
  assert.deepEqual(state.appended, []);
});

test("writeLine with no TIL heading appends at the end and leaves the journal alone", async () => {
  const { processor, state } = noteHarness("## Journal\n- a ^aaaaaaaa\n");
  await processor.writeLine(jot({ section: "til" }), LINE);
  assert.equal(state.note, `## Journal\n- a ^aaaaaaaa\n${LINE}\n`);
});

test("a split piece stays in its parent's section", () => {
  const { processor } = noteHarness("");
  assert.equal(
    processor.pieceJot(jot({ section: "til" }), "tail", 1).section,
    "til",
  );
  assert.equal(
    processor.pieceJot(jot({ section: "journal" }), "tail", 1).section,
    "journal",
  );
});
