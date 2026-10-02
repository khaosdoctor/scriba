import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../domain/jot/entity.ts";
import { editConfirmation, type StatusButtons } from "../libs/jot.ts";
import { anchorLine, journalLine, stripJournalLine } from "../libs/note.ts";
import { noteOps } from "../test/note-ops.ts";
import { sampleJot } from "../test/sqlite.ts";
import { EditController } from "./edits.ts";

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

function setup(over: { jot?: Jot | null; mapped?: boolean } = {}) {
  const row = over.jot === undefined ? jot() : over.jot;
  const notes = new Map([
    [NOTE, `# Journal\n${journalLine(TIME, "earlier", ID)}\n`],
  ]);
  const queued: [string, string][] = [];
  const statuses: [string, StatusButtons | undefined][] = [];
  const deleted: string[] = [];
  const repo = {
    jotForMessage: async () => (over.mapped === false ? undefined : ID),
    getJot: async () => row ?? undefined,
    queueEdit: async (id: string, text: string) => void queued.push([id, text]),
    markDeleted: async (id: string) => void deleted.push(id),
    groupFollowers: async () => [],
    updateJot: async () => {},
  };
  const obsidian: any = {
    readNote: async (path: string) => notes.get(path) ?? "",
    writeNote: async (path: string, content: string) =>
      void notes.set(path, content),
    ...noteOps(() => obsidian),
  };
  const jots = {
    status: async (_id: string, html: string, opts?: StatusButtons) =>
      void statuses.push([html, opts]),
  };
  const edits = new EditController({
    repo,
    obsidian,
    enricher: { editText: async (text: string) => text },
    jots,
  } as never);
  /** The jot's line as it now reads in the note, without its time and anchor. */
  const line = () => {
    const found = anchorLine(notes.get(NOTE) ?? "", ID);
    return found === null ? null : stripJournalLine(found, TIME);
  };
  return { edits, jots, queued, statuses, deleted, line };
}

const edited = (text: string) => ({ messageId: 77, text });

test("a blank edit whose last status can't be shown fails the update instead of going unhandled", async () => {
  const h = setup();
  h.jots.status = async (_id: string, html: string) => {
    if (html.startsWith("🗑️ removed")) throw new Error("telegram is down");
  };
  await assert.rejects(
    h.edits.editByMessageEdit(edited("")),
    /telegram is down/,
  );
  assert.equal(h.line(), null);
});

test("an edited TIL message loses a re-typed marker before it is applied", async () => {
  const h = setup({ jot: tilJot() });
  assert.equal(
    await h.edits.editByMessageEdit(edited("TIL: sqlite WAL")),
    "applied",
  );
  assert.equal(h.line(), "sqlite WAL");
  assert.deepEqual(
    h.statuses.map(([html]) => html),
    ["✍️ got your edit — applying…", editConfirmation(TIME, "sqlite WAL")],
  );
});

test("an edited journal message keeps a leading TIL as typed", async () => {
  const h = setup();
  await h.edits.editByMessageEdit(edited("TIL: foo"));
  assert.equal(h.line(), "TIL: foo");
});

test("an edit of a TIL jot still processing is queued without the marker", async () => {
  for (const status of ["pending", "processing"] as const) {
    const h = setup({ jot: tilJot({ status }) });
    assert.equal(
      await h.edits.editByMessageEdit(edited("TIL: new")),
      "queued",
      status,
    );
    assert.deepEqual(h.queued, [[ID, "new"]], status);
    assert.equal(h.line(), "earlier", status);
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
    const h = setup({ jot: tilJot() });
    await h.edits.editByMessageEdit(edited(bare));
    assert.equal(h.line(), bare.trim());
    assert.deepEqual(h.deleted, []);
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
  for (const h of [unmapped, gone]) {
    assert.deepEqual([h.queued, h.statuses, h.deleted], [[], [], []]);
    assert.equal(h.line(), "earlier");
  }
});

test("a reply instruction to a TIL jot still processing is queued verbatim", async () => {
  const h = setup({ jot: tilJot({ status: "processing" }) });
  assert.equal(await h.edits.editByReply(77, "TIL: make it shorter"), "queued");
  assert.deepEqual(h.queued, [[ID, "TIL: make it shorter"]]);
});
