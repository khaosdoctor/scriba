import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../domain/jot/entity.ts";
import { journalLine, stripJournalLine } from "../domain/jot/rules.ts";
import { editConfirmation, type StatusButtons } from "../libs/jot.ts";
import { anchorLine } from "../libs/note.ts";
import { noteOps } from "../test/note-ops.ts";
import { sampleJot } from "../test/sqlite.ts";
import { EditService } from "./edits.ts";

const ID = "aaaaaaaa";
const NOTE = "notes/daily notes/2026-08-16.md";
const TIME = "09:59:58";

const jot = (over: Partial<Jot> = {}): Jot =>
  sampleJot(ID, {
    note_path: NOTE,
    time: TIME,
    raw_text: "earlier",
    status: "done",
    ...over,
  });
const tilJot = (over: Partial<Jot> = {}) => jot({ section: "til", ...over });

function setup(
  over: {
    jot?: Jot | null;
    mapped?: boolean;
    text?: string;
    leader?: Jot;
    deleteFails?: boolean;
  } = {},
) {
  const row = over.jot === undefined ? jot() : over.jot;
  const notes = new Map([
    [NOTE, `# Journal\n${journalLine(TIME, over.text ?? "earlier", ID)}\n`],
  ]);
  const queued: [string, string][] = [];
  const updates: [string, object][] = [];
  const statuses: [string, StatusButtons | undefined][] = [];
  const deleted: string[] = [];
  const repo = {
    jotForMessage: async () => (over.mapped === false ? undefined : ID),
    getJot: async () => row ?? undefined,
    queueEdit: async (id: string, text: string) => void queued.push([id, text]),
    markDeleted: async (id: string) => void deleted.push(id),
    groupFollowers: async () => [],
    updateJot: async (id: string, patch: object) =>
      void updates.push([id, patch]),
  };
  const obsidian: any = {
    readNote: async (path: string) => notes.get(path) ?? "",
    writeNote: async (path: string, content: string) =>
      void notes.set(path, content),
    ...noteOps(() => obsidian),
  };
  const jots = {
    status: async (_id: string, html: string, opts?: StatusButtons) => {
      if (statusBroken) throw new Error("telegram down");
      statuses.push([html, opts]);
    },
    leaderOf: async (tapped: Jot) => over.leader ?? tapped,
  };
  const removedMsgs: number[] = [];
  let statusBroken = false;
  const pending: [string, string, string, string][] = [];
  const sent: { text: string; opts: unknown }[] = [];
  const events: string[] = [];
  const linkRules = {
    addPendingLink: async (
      pendingId: string,
      jotId: string,
      surface: string,
      note: string,
    ) => {
      pending.push([pendingId, jotId, surface, note]);
      events.push("addPendingLink");
    },
  };
  const notifier = {
    send: async (text: string, opts: unknown) => {
      sent.push({ text, opts });
      events.push("send");
      return 1;
    },
    delete: async (messageId: number) => {
      if (over.deleteFails) throw new Error("message to delete not found");
      removedMsgs.push(messageId);
    },
  };
  const edits = new EditService({
    repo,
    linkRules,
    obsidian,
    enricher: { editText: async (text: string) => text },
    jots,
    notifier,
  } as never);
  /** The jot's line as it now reads in the note, without its time and anchor. */
  const line = () => {
    const found = anchorLine(notes.get(NOTE) ?? "", ID);
    return found === null ? null : stripJournalLine(found, TIME);
  };
  return {
    edits,
    jots,
    queued,
    statuses,
    deleted,
    line,
    pending,
    sent,
    events,
    removedMsgs,
    notes,
    updates,
    statusFails: () => {
      statusBroken = true;
    },
  };
}

const edited = (text: string) => ({ messageId: 77, text });

test("asking about a link stores it pending, then sends a yes/no carrying its id", async () => {
  const harness = setup();
  const pendingId = await harness.edits.askLink(ID, "X", "N");
  assert.deepEqual(harness.pending, [[pendingId, ID, "X", "N"]]);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.text, 'Link "X" → [[N]]?');
  // plain text: the only option is the keyboard, no parse mode
  assert.deepEqual(harness.sent[0]?.opts, {
    keyboard: {
      inline_keyboard: [
        [
          { text: "Yes", callback_data: `lk:y:${pendingId}` },
          { text: "No", callback_data: `lk:n:${pendingId}` },
        ],
      ],
    },
  });
  assert.deepEqual(harness.events, ["addPendingLink", "send"]);
});

test("a blank edit whose last status can't be shown fails the update instead of going unhandled", async () => {
  const harness = setup();
  harness.jots.status = async (_id: string, html: string) => {
    if (html.startsWith("🗑️ removed")) throw new Error("telegram is down");
  };
  await assert.rejects(
    harness.edits.editByMessageEdit(edited("")),
    /telegram is down/,
  );
  assert.equal(harness.line(), null);
});

test("an edited TIL message loses a re-typed marker before it is applied", async () => {
  const harness = setup({ jot: tilJot() });
  assert.equal(
    await harness.edits.editByMessageEdit(edited("TIL: sqlite WAL")),
    "applied",
  );
  assert.equal(harness.line(), "sqlite WAL");
  assert.deepEqual(
    harness.statuses.map(([html]) => html),
    ["✍️ got your edit — applying…", editConfirmation(TIME, "sqlite WAL")],
  );
});

test("an edited journal message keeps a leading TIL as typed", async () => {
  const harness = setup();
  await harness.edits.editByMessageEdit(edited("TIL: foo"));
  assert.equal(harness.line(), "TIL: foo");
});

test("an edit of a TIL jot still processing is queued without the marker", async () => {
  for (const status of ["pending", "processing"] as const) {
    const harness = setup({ jot: tilJot({ status }) });
    assert.equal(
      await harness.edits.editByMessageEdit(edited("TIL: new")),
      "queued",
      status,
    );
    assert.deepEqual(harness.queued, [[ID, "new"]], status);
    assert.equal(harness.line(), "earlier", status);
  }
});

test("blanking a TIL message deletes it, and a bare marker is kept as text", async () => {
  for (const blank of ["", "   ", "\n"]) {
    const busy = setup({ jot: tilJot({ status: "processing" }) });
    assert.equal(
      await busy.edits.editByMessageEdit(edited(blank)),
      "removal-queued",
    );
    assert.deepEqual(busy.queued, [[ID, "delete"]]);

    const done = setup({ jot: tilJot() });
    assert.equal(await done.edits.editByMessageEdit(edited(blank)), "applied");
    assert.deepEqual(done.deleted, [ID]);
    assert.equal(done.line(), null);
    assert.deepEqual(
      done.statuses.map(([html]) => html),
      ["🗑️ got it — removing…", "🗑️ removed that from your journal."],
    );
  }
  for (const bare of ["TIL", "TIL:", "TIL   "]) {
    const harness = setup({ jot: tilJot() });
    await harness.edits.editByMessageEdit(edited(bare));
    assert.equal(harness.line(), bare.trim());
    assert.deepEqual(harness.deleted, []);
  }
});

test("an edit with no mapped message or no jot does nothing", async () => {
  const unmapped = setup({ mapped: false });
  assert.equal(
    await unmapped.edits.editByMessageEdit(edited("TIL: x y")),
    "unmapped",
  );
  const gone = setup({ jot: null });
  assert.equal(
    await gone.edits.editByMessageEdit(edited("TIL: x y")),
    "missing",
  );
  for (const harness of [unmapped, gone]) {
    assert.deepEqual(
      [harness.queued, harness.statuses, harness.deleted],
      [[], [], []],
    );
    assert.equal(harness.line(), "earlier");
  }
});

test("a reply instruction to a TIL jot still processing is queued verbatim", async () => {
  const harness = setup({ jot: tilJot({ status: "processing" }) });
  assert.equal(
    await harness.edits.editByReply(77, "TIL: make it shorter"),
    "queued",
  );
  assert.deepEqual(harness.queued, [[ID, "TIL: make it shorter"]]);
});

// --- ✏️ Edit ---

test("edit sends the line's text back as a copyable force-reply to the tapped message", async () => {
  const harness = setup({ text: "met [[Karl Barth|Karl]] Marx & co" });
  assert.equal(await harness.edits.askEdit(ID, 55), "asked");
  assert.deepEqual(harness.sent, [
    {
      text: `✏️ Reply with the new text for <code>${ID}</code>. Tap the block to copy it.\n<pre>met [[Karl Barth|Karl]] Marx &amp; co</pre>\n(ed:${ID})`,
      opts: {
        html: true,
        forceReply: true,
        placeholder: "The corrected entry",
        replyTo: 55,
      },
    },
  ]);
});

test("edit leaves a media jot's embed out of the prompt", async () => {
  const image = jot({ kind: "image", asset_path: "assets/p.jpg" });
  const harness = setup({ jot: image, text: "a sunset ![[assets/p.jpg]]" });
  await harness.edits.askEdit(ID, 55);
  assert.match(harness.sent[0]!.text, /<pre>a sunset<\/pre>/);
});

test("edit offers a video's caption, the embed's alias, as the text", async () => {
  const video = jot({
    kind: "video",
    asset_path: "assets/v.mp4",
    raw_text: "the dog",
  });
  const harness = setup({ jot: video, text: "![[assets/v.mp4|the dog]]" });
  await harness.edits.askEdit(ID, 55);
  assert.match(harness.sent[0]!.text, /<pre>the dog<\/pre>/);
});

test("edit refuses an entry too long for one Telegram message instead of cutting it", async () => {
  const harness = setup({ text: "word ".repeat(900).trim() });
  assert.equal(await harness.edits.askEdit(ID, 55), "too-long");
  assert.deepEqual(harness.sent, []);
});

test("edit on a squashed follower asks about its leader's line", async () => {
  const harness = setup({
    jot: jot({ id: "bbbbbbbb", anchor: ID }),
    leader: jot(),
  });
  assert.equal(await harness.edits.askEdit("bbbbbbbb", 55), "asked");
  assert.match(harness.sent[0]!.text, new RegExp(`\\(ed:${ID}\\)`));
});

test("edit refuses a jot that is gone, busy or missing its line", async () => {
  assert.equal(await setup({ jot: null }).edits.askEdit(ID, 55), "gone");
  assert.equal(await setup().edits.askEdit(undefined, 55), "gone");
  assert.equal(
    await setup({ jot: jot({ status: "deleted" }) }).edits.askEdit(ID, 55),
    "gone",
  );
  assert.equal(
    await setup({ jot: jot({ status: "processing" }) }).edits.askEdit(ID, 55),
    "busy",
  );
  const lost = setup();
  lost.notes.set(NOTE, "# Journal\n");
  assert.equal(await lost.edits.askEdit(ID, 55), "no-line");
  assert.deepEqual(lost.sent, []);
});

test("the answer to an edit prompt replaces the line, drops the prompt and keeps the buttons", async () => {
  const harness = setup({ text: "met [[Karl Barth|Karl]] Marx" });
  assert.equal(
    await harness.edits.answerEdit(ID, "met [[Karl Marx]]", 90),
    "applied",
  );
  assert.equal(harness.line(), "met [[Karl Marx]]");
  assert.deepEqual(harness.removedMsgs, [90]);
  assert.deepEqual(harness.statuses, [
    ["✍️ got your edit — applying…", undefined],
    [
      editConfirmation(TIME, "met [[Karl Marx]]"),
      { undo: true, embed: undefined },
    ],
  ]);
});

test("the answer to an edit prompt on a TIL jot loses a re-typed marker", async () => {
  const harness = setup({ jot: tilJot() });
  await harness.edits.answerEdit(ID, "TIL: octopuses have three hearts", 90);
  assert.equal(
    stripJournalLine(anchorLine(harness.notes.get(NOTE)!, ID)!, TIME),
    "octopuses have three hearts",
  );
});

test("the answer to an edit prompt keeps the prompt while the jot is busy, drops it once gone", async () => {
  const busy = setup({ jot: jot({ status: "processing" }) });
  assert.equal(await busy.edits.answerEdit(ID, "new", 90), "busy");
  assert.deepEqual(busy.removedMsgs, []);
  assert.deepEqual(busy.statuses, []);

  const gone = setup({ jot: jot({ status: "deleted" }) });
  assert.equal(await gone.edits.answerEdit(ID, "new", 90), "gone");
  assert.deepEqual(gone.removedMsgs, [90]);
  assert.equal(gone.line(), "earlier");

  const missing = setup({ jot: null });
  assert.equal(await missing.edits.answerEdit(ID, "new", 90), "gone");
});

test("the answer to a video's edit prompt rebuilds the embed around the new caption", async () => {
  const video = jot({
    kind: "video",
    asset_path: "assets/v.mp4",
    raw_text: "the dog",
  });
  const harness = setup({ jot: video, text: "![[assets/v.mp4|the dog]]" });
  assert.equal(await harness.edits.answerEdit(ID, "the cat", 90), "applied");
  assert.equal(harness.line(), "![[assets/v.mp4|the cat]]");
  assert.deepEqual(harness.updates, [[ID, { raw_text: "the cat" }]]);
});

test("the answer to an image's edit prompt folds the caption back without the embed", async () => {
  const image = jot({ kind: "image", asset_path: "assets/p.jpg" });
  const harness = setup({ jot: image, text: "a sunset ![[assets/p.jpg]]" });
  await harness.edits.answerEdit(ID, "a red sunset", 90);
  assert.equal(harness.line(), "a red sunset ![[assets/p.jpg]]");
  assert.deepEqual(harness.updates, [[ID, { raw_text: "a red sunset" }]]);
});

test("a literal edit of an image's line folds back the caption alone", async () => {
  const image = jot({ kind: "image", asset_path: "assets/p.jpg" });
  const harness = setup({ jot: image, text: "a sunset ![[assets/p.jpg]]" });
  await harness.edits.editByReply(77, "s/sunset/sunrise/");
  assert.deepEqual(harness.updates, [[ID, { raw_text: "a sunrise" }]]);
});

test("an edit that throws keeps its prompt for the retry", async () => {
  const harness = setup();
  harness.statusFails();
  await assert.rejects(harness.edits.answerEdit(ID, "new", 90));
  assert.deepEqual(harness.removedMsgs, []);
});

test("an edit prompt Telegram won't delete doesn't stop the edit", async () => {
  const harness = setup({ deleteFails: true });
  assert.equal(await harness.edits.answerEdit(ID, "new", 90), "applied");
  assert.equal(harness.line(), "new");
});

// --- /fix ---

const PIECE = "bbbbbbbb";

/** A voice jot split into two lines, with the fixer and the reprocess queue recorded. */
function fixSetup(
  over: {
    rows?: Jot[];
    model?: string;
    followers?: Jot[];
    fix?: (text: string) => Promise<string>;
    note?: string;
  } = {},
) {
  const rows = new Map(
    (
      over.rows ?? [
        jot({
          kind: "audio",
          raw_text: null,
          transcript: "so um we shipped [[Project Kite|the kite]] build",
        }),
        jot({
          id: PIECE,
          anchor: PIECE,
          raw_text: "and it went fine",
          parent_id: ID,
        }),
      ]
    ).map((row) => [row.id, row]),
  );
  const notes = new Map([
    [
      NOTE,
      over.note ??
        `# Journal\n${journalLine(TIME, "so um we shipped the kite build", ID)}\n${journalLine(TIME, "and it went fine", PIECE)}\n`,
    ],
  ]);
  const updates: [string, Partial<Jot>][] = [];
  const queued: string[][] = [];
  const fixed: string[] = [];
  const sent: string[] = [];
  const repo = {
    getJot: async (id: string) => rows.get(id),
    groupFollowers: async (id: string) =>
      id === ID ? (over.followers ?? []) : [],
    piecesOf: async (id: string) =>
      [...rows.values()].filter(
        (row) => row.parent_id === id && row.status !== "deleted",
      ),
    markDeleted: async (id: string) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, status: "deleted" });
    },
    updateJot: async (id: string, patch: Partial<Jot>) =>
      void updates.push([id, patch]),
    resetForReprocess: async (ids: string[]) => ids,
  };
  const obsidian: any = {
    readNote: async (path: string) => notes.get(path) ?? "",
    writeNote: async (path: string, content: string) =>
      void notes.set(path, content),
    ...noteOps(() => obsidian),
  };
  const edits = new EditService({
    repo,
    settings: {
      getSetting: async () =>
        over.model === undefined ? "fixer-model" : over.model,
    },
    obsidian,
    enricher: {
      fixTranscript: async (text: string) => {
        fixed.push(text);
        return over.fix
          ? over.fix(text)
          : "So we shipped the kite build, and it went fine.";
      },
    },
    jots: { deleteStatus: async () => {} },
    notifier: {
      send: async (text: string) => {
        sent.push(text);
        return 1;
      },
    },
    queue: { add: (ids: string[]) => void queued.push(ids) },
  } as never);
  return { edits, rows, notes, updates, queued, fixed, sent };
}

test("/fix on a split piece fixes the whole entry from its jot, drops the piece and reprocesses", async () => {
  const harness = fixSetup();
  await harness.edits.refix(PIECE);

  assert.deepEqual(harness.fixed, [
    "so um we shipped the kite build and it went fine",
  ]);
  assert.equal(harness.rows.get(PIECE)?.status, "deleted");
  assert.equal(harness.notes.get(NOTE)?.includes(PIECE), false);
  assert.deepEqual(harness.updates, [
    [
      ID,
      {
        transcript: "So we shipped the kite build, and it went fine.",
        original_transcript: "so um we shipped the kite build and it went fine",
      },
    ],
  ]);
  assert.deepEqual(harness.queued, [[ID]]);
  assert.match(
    harness.sent[0] ?? "",
    /Fixed text for <code>aaaaaaaa<\/code>:\n<blockquote expandable>So we shipped the kite build, and it went fine\.<\/blockquote>/,
  );
});

test("/fix folds pieces in the order they read in the note, whatever order they were stored in", async () => {
  const LATER = "cccccccc";
  const harness = fixSetup({
    rows: [
      jot({ raw_text: "first part" }),
      jot({ id: LATER, anchor: LATER, raw_text: "last part", parent_id: ID }),
      jot({ id: PIECE, anchor: PIECE, raw_text: "middle part", parent_id: ID }),
    ],
    note: `# Journal\n${journalLine(TIME, "first part", ID)}\n${journalLine(TIME, "middle part", PIECE)}\n${journalLine(TIME, "last part", LATER)}\n`,
  });
  await harness.edits.refix(ID);
  assert.deepEqual(harness.fixed, ["first part middle part last part"]);
});

test("/fix on a text jot fixes its raw text", async () => {
  const harness = fixSetup({
    rows: [jot({ raw_text: "went  running" })],
    fix: async () => "Went running.",
  });
  await harness.edits.refix(ID);
  assert.deepEqual(harness.updates, [
    [ID, { raw_text: "Went running.", original_transcript: "went  running" }],
  ]);
});

test("/fix leaves an already clean entry alone", async () => {
  const harness = fixSetup({ fix: async (text) => text });
  await harness.edits.refix(ID);
  assert.deepEqual(harness.updates, []);
  assert.deepEqual(harness.queued, []);
  assert.equal(harness.rows.get(PIECE)?.status, "done");
  assert.match(harness.sent[0] ?? "", /Nothing to fix/);
});

test("/fix refuses what it can't fix without calling the model", async () => {
  const cases: [string, Parameters<typeof fixSetup>[0], RegExp][] = [
    ["missing", { rows: [] }, /not found/],
    ["deleted", { rows: [jot({ status: "deleted" })] }, /not found/],
    ["video", { rows: [jot({ kind: "video" })] }, /no text to fix/],
    ["empty", { rows: [jot({ raw_text: "  " })] }, /no text to fix/],
    ["squashed", { followers: [jot({ id: "cccccccc" })] }, /squashed/],
    ["busy", { rows: [jot({ status: "processing" })] }, /still processing/],
    ["no model", { model: "" }, /No voice-fix model/],
  ];
  for (const [label, options, reply] of cases) {
    const harness = fixSetup(options);
    await harness.edits.refix(ID);
    assert.match(harness.sent[0] ?? "", reply, label);
    assert.deepEqual(harness.fixed, [], label);
    assert.deepEqual(harness.updates, [], label);
  }
});

test("/fix on a piece whose jot was deleted fixes the piece alone", async () => {
  const harness = fixSetup({
    rows: [
      jot({ status: "deleted" }),
      jot({
        id: PIECE,
        anchor: PIECE,
        raw_text: "and it went fine",
        parent_id: ID,
      }),
    ],
    fix: async () => "And it went fine.",
  });
  await harness.edits.refix(PIECE);
  assert.deepEqual(harness.fixed, ["and it went fine"]);
  assert.deepEqual(harness.queued, [[PIECE]]);
});

test("/fix on a jot that starts processing before the reset queues nothing", async () => {
  const harness = fixSetup();
  (harness.edits as any).deps.repo.resetForReprocess = async () => [];
  await harness.edits.refix(ID);
  assert.deepEqual(harness.queued, []);
  assert.match(harness.sent[0] ?? "", /still processing/);
});

test("/fix survives a Telegram failure while reporting a failed fix", async () => {
  const harness = fixSetup({
    fix: async () => {
      throw new Error("model down");
    },
  });
  (harness.edits as any).deps.notifier.send = async () => {
    throw new Error("telegram down");
  };
  await harness.edits.refix(ID);
  assert.deepEqual(harness.updates, []);
});

test("/fix reports a failed model call instead of throwing", async () => {
  const harness = fixSetup({
    fix: async () => {
      throw new Error("model <down>");
    },
  });
  await harness.edits.refix(ID);
  assert.deepEqual(harness.sent, [
    "🔧 Couldn't fix aaaaaaaa: model &lt;down&gt;",
  ]);
  assert.deepEqual(harness.updates, []);
});
