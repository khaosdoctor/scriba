import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { Repository } from "../data/repositories/index.ts";
import { type Jot, MAX_ATTEMPTS } from "../domain/jot/entity.ts";
import type { SettingKey } from "../domain/setting/entity.ts";
import { insertJournalLine } from "../libs/note.ts";
import { ModelsDownError } from "../services/enrich.ts";
import { FakeSettings } from "../test/fakes.ts";
import { noteOps } from "../test/note-ops.ts";
import { removeDb, sampleJot, tempDbPath } from "../test/sqlite.ts";
import { HELD as HELD_MARKER, ProcessingController } from "./processing.ts";

/** Status messages the bot was asked to post, with the buttons each one carried. */
type Posted = { id: string; html: string; opts: any };

const jot = (over: Partial<Jot> = {}): Jot =>
  sampleJot("abcd1234", {
    status: "processing",
    raw_text: "a thought",
    note_path: "notes/daily notes/2026-08-16.md",
    ...over,
  });

/** A processor whose collaborators only record what they were asked to do. The note write
 *  throws, which is the give-up path's own escape hatch: it keeps the stubs to the parts
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
    ...new FakeSettings(
      over.detection
        ? { taskDetection: over.detection, tilDetection: over.detection }
        : {},
    ),
    taskDraftsForJot: async () => over.priorDrafts ?? 0,
    tilOffered: async () => over.tilAsked ?? false,
  };
  const obsidian = {
    ensureDailyNote: async () => {
      throw new Error("obsidian is down");
    },
  };
  const jots = {
    status: async (id: string, html: string, opts?: any) => {
      posted.push({ id, html, opts });
    },
    react: async (id: string, state: string) =>
      void reactions.push([id, state]),
    deleteStatus: async () => {},
  };
  const processor: any = new ProcessingController({
    repo,
    obsidian,
    jots,
    edits: { drainQueued: async () => {} },
  } as any);
  return { processor, posted, reactions, updates };
}

/** Which buttons a status message asked for. */
const buttons = (message: Posted | undefined) => ({
  retry: !!message?.opts?.retry,
  discard: !!message?.opts?.discard,
});

test("a transient failure says so on the jot's message, with both buttons", async () => {
  const { processor, posted, reactions, updates } = harness();
  await processor.fail(jot(), new Error("fetch failed"));

  // It stays in the retry cycle…
  assert.deepEqual(updates, [
    ["abcd1234", { status: "failed", attempts: 1, error: "fetch failed" }],
  ]);
  assert.deepEqual(reactions, [["abcd1234", "retrying"]]);
  // …and the message says that instead of staying on "Weaving it into your journal…".
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
  (processor as any).deps.jots.status = async () => {
    throw new Error("telegram 502");
  };
  // fail() runs inside processJot's catch: a throw here would abandon the other jots.
  await processor.fail(jot(), new Error("fetch failed"));
});

// --- tasks spotted in a jot ---

const detected = [
  { description: "Call the vet tomorrow", type: "personal" },
  { description: "Answer the RFC", due: "next friday", type: "work" },
];

test("detected tasks become drafts dated from the jot's own day", async () => {
  const { processor } = harness();
  // The jot's note is 2026-08-16 (a Sunday), so "tomorrow" is the day after the entry,
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

  // A jot that already produced drafts was asked about once: /reprocess must not ask
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
    ambiguous?: { surface: string; note: string }[];
  } = {},
) {
  const calls: string[] = [];
  const sent: { text: string; opts: unknown }[] = [];
  const pending: { pid: string; surface: string; note: string }[] = [];
  const tilAsks: [string, string][] = [];
  const enriched: string[] = [];
  const offered = new Set<string>();
  const leader = jot({
    status: "pending",
    section: over.section ?? "journal",
    raw_text: over.raw ?? "a thought",
  } as Partial<Jot>);
  const jots = new Map<string, Jot>(
    [leader, ...(over.followers ?? [])].map((storedJot) => [
      storedJot.id,
      storedJot,
    ]),
  );
  let note = `## Journal\n- _10:00:00 ::_ ⏳ ^${leader.id}`;
  const repo = {
    getJot: async (id: string) => jots.get(id),
    claim: async () => true,
    ...new FakeSettings(),
    updateJot: async () => {},
    groupFollowers: async () => over.followers ?? [],
    stopwords: async () => new Set<string>(),
    rejections: async () => new Set<string>(),
    registeredLinks: async () => [],
    addPendingLink: async (
      pid: string,
      _jotId: string,
      surface: string,
      linked: string,
    ) => {
      pending.push({ pid, surface, note: linked });
      calls.push("addPendingLink");
    },
    taskDraftsForJot: async () => 0,
    tilOffered: async (id: string) => offered.has(id),
    insertJot: async () => {},
  };
  const obsidian: any = {
    ensureDailyNote: async () => "",
    ...noteOps(() => obsidian),
    readNote: async (_p: string) => note,
    writeNote: async (_p: string, content: string) => {
      if (over.writeFails) throw new Error("obsidian is down");
      note = content;
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
        ambiguous: over.ambiguous ?? [],
        tasks: over.tasks ?? [],
        til: over.til ?? false,
        usage: { input: 0, output: 0 },
      };
    },
  };
  const jotFakes = {
    status: async (_id: string, _html: string, opts?: { undo?: boolean }) =>
      void calls.push(opts?.undo ? "status:done" : "status"),
    react: async () => {},
    deleteStatus: async () => {},
    askTil: async (id: string, text: string) => {
      tilAsks.push([id, text]);
      calls.push("askTil");
    },
  };
  const processor: any = new ProcessingController({
    repo,
    obsidian,
    enricher,
    links: { list: () => [] },
    jots: jotFakes,
    edits: { drainQueued: async () => void calls.push("onJotDone") },
    tasks: {
      suggest: async (draft: { description: string }) =>
        void calls.push(`askTask:${draft.description}`),
    },
    notifier: {
      typing: async () => {},
      send: async (text: string, opts: unknown) => {
        sent.push({ text, opts });
        calls.push("send");
      },
    },
  } as any);
  return {
    processor,
    calls,
    sent,
    pending,
    tilAsks,
    enriched,
    offered,
    leaderId: leader.id,
    note: () => note,
  };
}

test("a jot the enricher read as a TIL gets its card after the entry is written and before the drain", async () => {
  const scenario = pipeline({ til: true });
  await scenario.processor.processJot(scenario.leaderId);
  assert.deepEqual(scenario.tilAsks, [[scenario.leaderId, "Learned that X"]]);
  const at = (call: string) => scenario.calls.indexOf(call);
  assert.ok(at("write") < at("status:done"));
  assert.ok(at("status:done") < at("askTil"));
  assert.ok(at("askTil") < at("onJotDone"));
});

test("an ambiguous link asks for a yes/no with the pending link's id", async () => {
  const p = pipeline({ ambiguous: [{ surface: "X", note: "N" }] });
  await p.processor.processJot(p.leaderId);
  assert.equal(p.pending.length, 1);
  const pid = p.pending[0]?.pid;
  assert.deepEqual(p.pending[0], { pid, surface: "X", note: "N" });
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0]?.text, 'Link "X" → [[N]]?');
  // plain text: the only option is the keyboard, no parse mode
  assert.deepEqual(p.sent[0]?.opts, {
    keyboard: {
      inline_keyboard: [
        [
          { text: "Yes", callback_data: `lk:y:${pid}` },
          { text: "No", callback_data: `lk:n:${pid}` },
        ],
      ],
    },
  });
  assert.ok(p.calls.indexOf("addPendingLink") < p.calls.indexOf("send"));
});

test("no card when the enricher did not read it as a TIL", async () => {
  const scenario = pipeline({ til: false });
  await scenario.processor.processJot(scenario.leaderId);
  assert.deepEqual(scenario.tilAsks, []);
  assert.ok(scenario.calls.includes("status:done"));
  assert.ok(scenario.calls.includes("onJotDone"));
});

test("a blank jot never reaches the enricher or the card", async () => {
  for (const raw of ["", "   "]) {
    const scenario = pipeline({ til: true, raw });
    await scenario.processor.processJot(scenario.leaderId);
    assert.deepEqual(scenario.enriched, []);
    assert.deepEqual(scenario.tilAsks, []);
    assert.ok(scenario.calls.includes("status:done"));
  }
});

test("a jot whose note write fails gets no card", async () => {
  const scenario = pipeline({ til: true, writeFails: true });
  await scenario.processor.processJot(scenario.leaderId);
  assert.deepEqual(scenario.tilAsks, []);
});

test("a task card comes before the TIL card, both before the drain", async () => {
  const scenario = pipeline({
    til: true,
    tasks: [{ description: "book flights", type: "personal" }],
  });
  await scenario.processor.processJot(scenario.leaderId);
  const at = (call: string) => scenario.calls.indexOf(call);
  assert.ok(at("askTask:book flights") < at("askTil"));
  assert.ok(at("askTil") < at("onJotDone"));
  assert.equal(scenario.tilAsks[0]?.[0], scenario.leaderId);
});

test("a squashed burst asks once, for the leader, on the leader's section", async () => {
  const follower = jot({
    id: "f0000001",
    anchor: "abcd1234",
    status: "pending",
    raw_text: "and more",
    section: "til",
  } as Partial<Jot>);
  const scenario = pipeline({ til: true, followers: [follower] });
  await scenario.processor.processJot(scenario.leaderId);
  assert.deepEqual(scenario.tilAsks, [[scenario.leaderId, "Learned that X"]]);
  assert.match(scenario.enriched[0]!, /a thought/);
  assert.match(scenario.enriched[0]!, /and more/);
});

test("a TIL jot is never offered the card", async () => {
  const scenario = pipeline({ til: true, section: "til" });
  await scenario.processor.processJot(scenario.leaderId);
  assert.deepEqual(scenario.tilAsks, []);
});

test("a reprocess after the card was sent does not ask again", async () => {
  const scenario = pipeline({ til: true });
  await scenario.processor.processJot(scenario.leaderId);
  scenario.offered.add(scenario.leaderId); // what JotController.askTil does once the card is out
  await scenario.processor.processJot(scenario.leaderId);
  assert.equal(scenario.tilAsks.length, 1);
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

  // a retry pass that finds it still held says nothing more
  await processor.hold(jot({ error: HELD_MARKER }));
  assert.equal(posted.length, 1);
});

test("a held notice that couldn't be sent isn't marked, so the next retry pass tries again", async () => {
  const { processor, updates } = harness();
  processor.deps.jots.status = async () => {
    throw new Error("telegram 502");
  };
  await processor.hold(jot());
  assert.deepEqual(updates, []);
});

/** A processor over an in-memory note, with appends routed through the real
 *  insertJournalLine the way ObsidianClient does it. */
function noteHarness(note: string) {
  const state = { note, writes: 0, appended: [] as [string, string, string][] };
  const obsidian: any = {
    ensureDailyNote: async () => "",
    ...noteOps(() => obsidian),
    readNote: async (_p: string) => state.note,
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
  const processor: any = new ProcessingController({ obsidian } as any);
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

// --- processBatch, retryPass and the media/voice steps, over a real sqlite repository ---

type Seen = { id: string; html: string; opts: any };

const stored = (over: Partial<Jot> = {}): Jot =>
  jot({
    status: "pending",
    received_at: 1000,
    updated_at: 1000,
    ...over,
  });

interface WorldOptions {
  settings?: Partial<Record<SettingKey, string>>;
  enrichText?: string;
  fixTranscript?: (original: string, model: string) => Promise<string>;
  voiceChoice?: "original" | "proposed";
}

async function world(testContext: TestContext, options: WorldOptions = {}) {
  const dbPath = tempDbPath();
  let repo: Repository;
  try {
    repo = await Repository.open(dbPath);
  } catch (error) {
    testContext.skip(
      `native sqlite unavailable: ${(error as Error).message.slice(0, 80)}`,
    );
    return null;
  }
  testContext.after(async () => {
    await repo.close();
    await removeDb(dbPath);
  });
  await repo.seedSettings(options.settings ?? {});

  const statuses: Seen[] = [];
  const reactions: [string, string][] = [];
  const calls: string[] = [];
  const enriched: string[] = [];
  const assets: string[] = [];
  const voiceFixAsks: [string, string][] = [];
  let note = "## Journal\n";

  const add = async (newJot: Jot) => {
    await repo.insertJot(newJot);
    if (newJot.anchor === newJot.id)
      note = insertJournalLine(
        note,
        "Journal",
        `- _${newJot.time} ::_ ⏳ ^${newJot.anchor}`,
      );
  };

  const obsidian: any = {
    ensureDailyNote: async () => "",
    ...noteOps(() => obsidian),
    readNote: async (_p: string) => note,
    writeNote: async (_p: string, content: string) => {
      note = content;
    },
    appendJournalLine: async (_d: string, line: string) => {
      note = insertJournalLine(note, "Journal", line);
    },
    saveAsset: async (name: string, bytes: Uint8Array, mime: string) => {
      calls.push(`saveAsset:${name}:${bytes.length}:${mime}`);
      assets.push(name);
      return `assets/${name}`;
    },
  };
  const transcriber = {
    transcribe: async (bytes: Uint8Array, ext: string) => {
      calls.push(`transcribe:${bytes.length}:${ext}`);
      return "spoken words";
    },
  };
  const enricher = {
    available: () => true,
    enrich: async (input: { text: string }) => {
      enriched.push(input.text);
      return {
        text: options.enrichText ?? input.text,
        ambiguous: [],
        tasks: [],
        til: false,
        usage: { input: 0, output: 0 },
      };
    },
    fixTranscript:
      options.fixTranscript ?? (async (original: string) => original),
    describeImage: async (bytes: Uint8Array, mime: string) => {
      calls.push(`describeImage:${bytes.length}:${mime}`);
      return "a red door";
    },
  };
  const jots = {
    status: async (id: string, html: string, opts?: any) => {
      statuses.push({ id, html, opts });
    },
    react: async (id: string, state: string) => {
      reactions.push([id, state]);
    },
    deleteStatus: async () => {},
    askTil: async () => {},
    awaitVoiceFix: async (_id: string, original: string, proposed: string) => {
      voiceFixAsks.push([original, proposed]);
      return options.voiceChoice ?? "proposed";
    },
  };
  const processor = new ProcessingController({
    repo,
    obsidian,
    transcriber,
    enricher,
    links: { list: () => [] },
    jots,
    edits: { drainQueued: async () => {} },
    tasks: { suggest: async () => {} },
    notifier: { typing: async () => {} },
    files: {
      downloadFile: async (fileId: string) => {
        calls.push(`download:${fileId}`);
        if (fileId === "voice-file")
          return { bytes: new Uint8Array(3), ext: "oga", mime: "audio/ogg" };
        if (fileId === "video-file")
          return { bytes: new Uint8Array(3), ext: "mp4", mime: "video/mp4" };
        return { bytes: new Uint8Array(3), ext: "jpg", mime: "image/jpeg" };
      },
    },
  } as any);
  return {
    repo,
    processor,
    add,
    note: () => note,
    statuses,
    reactions,
    calls,
    enriched,
    assets,
    voiceFixAsks,
    htmls: () => statuses.map((seen) => seen.html),
  };
}

test("a batch processes its jots one after the other, in the order given", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  await testWorld.add(
    stored({ id: "aaaaaaaa", anchor: "aaaaaaaa", raw_text: "first" }),
  );
  await testWorld.add(
    stored({ id: "bbbbbbbb", anchor: "bbbbbbbb", raw_text: "second" }),
  );
  await testWorld.processor.processBatch(["bbbbbbbb", "aaaaaaaa"]);

  assert.deepEqual(testWorld.enriched, ["second", "first"]);
  assert.equal((await testWorld.repo.getJot("aaaaaaaa"))?.status, "done");
  assert.equal((await testWorld.repo.getJot("bbbbbbbb"))?.status, "done");
  assert.deepEqual(testWorld.reactions, [
    ["bbbbbbbb", "done"],
    ["aaaaaaaa", "done"],
  ]);
  assert.match(testWorld.note(), /first \^aaaaaaaa/);
  assert.match(testWorld.note(), /second \^bbbbbbbb/);
});

test("a batch naming a jot that no longer exists skips it and carries on", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  await testWorld.add(stored({ id: "aaaaaaaa", anchor: "aaaaaaaa" }));
  await testWorld.processor.processBatch(["gone0000", "aaaaaaaa"]);
  assert.equal((await testWorld.repo.getJot("aaaaaaaa"))?.status, "done");
});

test("retryPass picks up pending jots and failed ones under the cap, and nothing else", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  const row = (id: string, status: Jot["status"], attempts = 0) =>
    testWorld.add(
      stored({
        id,
        anchor: id,
        status,
        attempts,
        raw_text: `text ${id}`,
        received_at: Number.parseInt(id.slice(0, 1), 16) + 1,
      }),
    );
  await row("1aaaaaaa", "pending");
  await row("2aaaaaaa", "failed", MAX_ATTEMPTS - 1);
  await row("3aaaaaaa", "failed", MAX_ATTEMPTS);
  await row("4aaaaaaa", "done");
  await row("5aaaaaaa", "abandoned");
  await row("6aaaaaaa", "processing");
  await row("7aaaaaaa", "deleted");

  await testWorld.processor.retryPass();

  assert.deepEqual(testWorld.enriched, ["text 1aaaaaaa", "text 2aaaaaaa"]);
  const statusOf = async (id: string) =>
    (await testWorld.repo.getJot(id))?.status;
  assert.equal(await statusOf("1aaaaaaa"), "done");
  assert.equal(await statusOf("2aaaaaaa"), "done");
  assert.equal(await statusOf("3aaaaaaa"), "failed");
  assert.equal(await statusOf("6aaaaaaa"), "processing");
});

test("retryPass with nothing pending does no work", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  await testWorld.add(stored({ status: "done" }));
  await testWorld.processor.retryPass();
  assert.deepEqual(testWorld.enriched, []);
  assert.deepEqual(testWorld.statuses, []);
});

test("a squashed follower waits for its leader and does no work of its own", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  await testWorld.add(stored({ id: "aaaaaaaa", anchor: "aaaaaaaa" }));
  await testWorld.add(
    stored({ id: "ffff0001", anchor: "aaaaaaaa", received_at: 1001 }),
  );
  await testWorld.processor.processJot("ffff0001");

  assert.deepEqual(testWorld.enriched, []);
  assert.deepEqual(testWorld.statuses, []);
  assert.equal((await testWorld.repo.getJot("ffff0001"))?.status, "pending");
});

test("a follower left behind by a finished leader is marked done, not processed again", async (testContext) => {
  for (const leaderStatus of ["done", "abandoned"] as const) {
    const testWorld = await world(testContext);
    if (!testWorld) return;
    await testWorld.add(
      stored({ id: "aaaaaaaa", anchor: "aaaaaaaa", status: leaderStatus }),
    );
    await testWorld.add(
      stored({
        id: "ffff0001",
        anchor: "aaaaaaaa",
        status: "failed",
        error: "left over",
        received_at: 1001,
      }),
    );
    await testWorld.processor.processJot("ffff0001");

    const follower = await testWorld.repo.getJot("ffff0001");
    assert.equal(follower?.status, "done");
    assert.equal(follower?.error, null);
    assert.deepEqual(testWorld.enriched, []);
  }
});

test("a follower whose leader was deleted is processed on its own and appended to the note", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  await testWorld.add(
    stored({ id: "aaaaaaaa", anchor: "aaaaaaaa", status: "deleted" }),
  );
  await testWorld.add(
    stored({
      id: "ffff0001",
      anchor: "aaaaaaaa",
      raw_text: "orphaned thought",
      received_at: 1001,
    }),
  );
  await testWorld.processor.processJot("ffff0001");

  assert.deepEqual(testWorld.enriched, ["orphaned thought"]);
  assert.equal((await testWorld.repo.getJot("ffff0001"))?.status, "done");
  assert.match(testWorld.note(), /orphaned thought \^aaaaaaaa/);
});

const voiceSettings = {
  voiceFixModel: "haiku-test",
  fixVoiceTranscript: "on",
};
const voiceJot = (transcript: string) =>
  stored({
    kind: "audio",
    raw_text: null,
    transcript,
    file_id: "voice-file",
  });

test("a voice fix with a change asks which one to keep, and the pick is what gets enriched", async (testContext) => {
  const testWorld = await world(testContext, {
    settings: voiceSettings,
    fixTranscript: async () => "Ship the release on Friday.",
    voiceChoice: "proposed",
  });
  if (!testWorld) return;
  await testWorld.add(voiceJot("ship the release on friday"));
  await testWorld.processor.processJot("abcd1234");

  assert.deepEqual(testWorld.htmls().slice(0, 4), [
    "🎤 Transcribing your voice note…",
    "🎤 <i>ship the release on friday</i>\n\n✨ Weaving it into your journal…",
    "🎤 <i>ship the release on friday</i>\n\n🔧 Checking transcript…",
    "🎤 <i>Ship the release on Friday.</i>\n\n✨ Weaving it into your journal…",
  ]);
  assert.deepEqual(testWorld.voiceFixAsks, [
    ["ship the release on friday", "Ship the release on Friday."],
  ]);
  assert.deepEqual(testWorld.enriched, ["Ship the release on Friday."]);
  assert.equal(
    (await testWorld.repo.getJot("abcd1234"))?.transcript,
    "Ship the release on Friday.",
  );
});

test("picking the original keeps the transcript as it was", async (testContext) => {
  const testWorld = await world(testContext, {
    settings: voiceSettings,
    fixTranscript: async () => "Ship the release on Friday.",
    voiceChoice: "original",
  });
  if (!testWorld) return;
  await testWorld.add(voiceJot("ship the release on friday"));
  await testWorld.processor.processJot("abcd1234");

  assert.equal(
    testWorld.htmls()[3],
    "🎤 <i>ship the release on friday</i>\n\n✨ Weaving it into your journal…",
  );
  assert.deepEqual(testWorld.enriched, ["ship the release on friday"]);
  assert.equal(
    (await testWorld.repo.getJot("abcd1234"))?.transcript,
    "ship the release on friday",
  );
});

test("a voice fix that changes nothing asks nobody and escapes the transcript in HTML", async (testContext) => {
  const testWorld = await world(testContext, { settings: voiceSettings });
  if (!testWorld) return;
  await testWorld.add(voiceJot("if a < b & c"));
  await testWorld.processor.processJot("abcd1234");

  assert.deepEqual(testWorld.voiceFixAsks, []);
  assert.deepEqual(testWorld.htmls().slice(0, 4), [
    "🎤 Transcribing your voice note…",
    "🎤 <i>if a &lt; b &amp; c</i>\n\n✨ Weaving it into your journal…",
    "🎤 <i>if a &lt; b &amp; c</i>\n\n🔧 Checking transcript…",
    "🎤 <i>if a &lt; b &amp; c</i>\n\n✨ Weaving it into your journal…",
  ]);
  assert.deepEqual(testWorld.enriched, ["if a < b & c"]);
});

test("a voice fix that errors keeps the original transcript and the jot still completes", async (testContext) => {
  const testWorld = await world(testContext, {
    settings: voiceSettings,
    fixTranscript: async () => {
      throw new Error("fix model 500");
    },
  });
  if (!testWorld) return;
  await testWorld.add(voiceJot("plain words"));
  await testWorld.processor.processJot("abcd1234");

  assert.deepEqual(testWorld.voiceFixAsks, []);
  assert.deepEqual(testWorld.enriched, ["plain words"]);
  assert.equal((await testWorld.repo.getJot("abcd1234"))?.status, "done");
});

test("the voice fix is skipped when it is off or has no model", async (testContext) => {
  const variants: WorldOptions["settings"][] = [
    { voiceFixModel: "haiku-test" },
    { fixVoiceTranscript: "on" },
    { voiceFixModel: "haiku-test", fixVoiceTranscript: "off" },
  ];
  for (const settings of variants) {
    const testWorld = await world(testContext, {
      settings,
      fixTranscript: async () => {
        throw new Error("must not be called");
      },
    });
    if (!testWorld) return;
    await testWorld.add(voiceJot("plain words"));
    await testWorld.processor.processJot("abcd1234");

    assert.equal((await testWorld.repo.getJot("abcd1234"))?.status, "done");
    assert.ok(
      !testWorld.htmls().some((html) => html.includes("Checking transcript")),
    );
  }
});

test("every model down during the voice fix holds the jot: pending, no attempt charged, held notice", async (testContext) => {
  const testWorld = await world(testContext, {
    settings: voiceSettings,
    fixTranscript: async () => {
      throw new ModelsDownError(new Error("overloaded 529"));
    },
  });
  if (!testWorld) return;
  await testWorld.add(voiceJot("plain words"));
  const before = testWorld.note();
  await testWorld.processor.processJot("abcd1234");

  const row = await testWorld.repo.getJot("abcd1234");
  assert.equal(row?.status, "pending");
  assert.equal(row?.attempts, 0);
  assert.equal(row?.error, HELD_MARKER);
  assert.deepEqual(testWorld.voiceFixAsks, []);
  assert.deepEqual(testWorld.enriched, []);
  assert.equal(testWorld.note(), before);
  const last = testWorld.statuses.at(-1);
  assert.match(last!.html, /Every enrichment model is down/);
  assert.deepEqual(last!.opts, { discard: true });
});

test("an image with a caption is saved to the vault, embedded, and never sent to vision", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  await testWorld.add(
    stored({
      kind: "image",
      raw_text: "the front door",
      file_id: "photo-file",
    }),
  );
  await testWorld.processor.processJot("abcd1234");

  assert.deepEqual(testWorld.calls, [
    "download:photo-file",
    "saveAsset:2026-08-16_100000_abcd1234.jpg:3:image/jpeg",
  ]);
  const row = await testWorld.repo.getJot("abcd1234");
  assert.equal(row?.asset_path, "assets/2026-08-16_100000_abcd1234.jpg");
  assert.equal(row?.raw_text, "the front door");
  assert.match(
    testWorld.note(),
    /the front door !\[\[assets\/2026-08-16_100000_abcd1234\.jpg\]\] \^abcd1234/,
  );
});

test("a captionless image gets a vision caption that becomes its entry text", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  await testWorld.add(
    stored({ kind: "image", raw_text: "", file_id: "photo-file" }),
  );
  await testWorld.processor.processJot("abcd1234");

  assert.deepEqual(testWorld.calls, [
    "download:photo-file",
    "saveAsset:2026-08-16_100000_abcd1234.jpg:3:image/jpeg",
    "describeImage:3:image/jpeg",
  ]);
  assert.equal(
    (await testWorld.repo.getJot("abcd1234"))?.raw_text,
    "a red door",
  );
  assert.deepEqual(testWorld.enriched, ["a red door"]);
});

test("a voice note without a transcript is downloaded and transcribed, never attached", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  await testWorld.add(
    stored({
      kind: "audio",
      raw_text: null,
      transcript: null,
      file_id: "voice-file",
    }),
  );
  await testWorld.processor.processJot("abcd1234");

  assert.deepEqual(testWorld.calls, [
    "download:voice-file",
    "transcribe:3:oga",
  ]);
  const row = await testWorld.repo.getJot("abcd1234");
  assert.equal(row?.transcript, "spoken words");
  assert.equal(row?.asset_path, null);
  assert.deepEqual(testWorld.enriched, ["spoken words"]);
});

test("a video is saved and embedded but never transcribed, captioned or enriched", async (testContext) => {
  const testWorld = await world(testContext, { settings: voiceSettings });
  if (!testWorld) return;
  await testWorld.add(
    stored({ kind: "video", raw_text: "", file_id: "video-file" }),
  );
  await testWorld.processor.processJot("abcd1234");

  assert.deepEqual(testWorld.calls, [
    "download:video-file",
    "saveAsset:2026-08-16_100000_abcd1234.mp4:3:video/mp4",
  ]);
  assert.deepEqual(testWorld.enriched, []);
  const row = await testWorld.repo.getJot("abcd1234");
  assert.equal(row?.status, "done");
  assert.equal(row?.raw_text, "");
  assert.match(
    testWorld.note(),
    /!\[\[assets\/2026-08-16_100000_abcd1234\.mp4\]\]/,
  );
});

test("media already on file is not downloaded again", async (testContext) => {
  const testWorld = await world(testContext);
  if (!testWorld) return;
  await testWorld.add(
    stored({
      id: "aaaaaaaa",
      anchor: "aaaaaaaa",
      kind: "image",
      raw_text: "kept",
      file_id: "photo-file",
      asset_path: "assets/already.jpg",
    }),
  );
  await testWorld.add(
    stored({
      id: "bbbbbbbb",
      anchor: "bbbbbbbb",
      kind: "audio",
      raw_text: null,
      transcript: "already heard",
      file_id: "voice-file",
    }),
  );
  await testWorld.add(
    stored({ id: "cccccccc", anchor: "cccccccc", file_id: null }),
  );
  await testWorld.processor.processBatch(["aaaaaaaa", "bbbbbbbb", "cccccccc"]);

  assert.deepEqual(testWorld.calls, []);
  assert.equal((await testWorld.repo.getJot("aaaaaaaa"))?.status, "done");
});

test("an over-long entry's spillover jots copy the parent row, til_offered included", async (testContext) => {
  const testWorld = await world(testContext, {
    settings: { entryMaxChars: "40" },
    enrichText:
      "The first sentence is a fairly long one. The second sentence is also a long one.",
  });
  if (!testWorld) return;
  await testWorld.add(stored());
  await testWorld.repo.markTilOffered("abcd1234");
  await testWorld.processor.processJot("abcd1234");

  const rows = await testWorld.repo.recentJots(3);
  assert.equal(rows.length, 2);
  const [piece, parent] = rows;
  assert.equal(parent?.id, "abcd1234");
  assert.equal(parent?.raw_text, "The first sentence is a fairly long one.");
  assert.equal(piece?.raw_text, "The second sentence is also a long one.");
  assert.equal(piece?.status, "done");
  assert.equal(piece?.section, "journal");
  assert.equal(piece?.anchor, piece?.id);
  assert.equal(piece?.received_at, 1001);
  assert.equal(await testWorld.repo.tilOffered(piece!.id), true);
});
