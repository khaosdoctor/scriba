import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskNoteRepository } from "../data/repositories/task-notes.ts";
import type { TaskDraftRow, TaskType } from "../domain/task/entity.ts";
import { FakeSettings } from "../test/fakes.ts";
import { noteOps } from "../test/note-ops.ts";
import { Modes } from "./modes.ts";
import { TaskService } from "./tasks.ts";

const OWNER = 7;

type Sent = { text: string; opts: any };
type Edited = { id: number; text: string; opts: any };

/** A controller over an in-memory task note, a draft table and a chat that only records.
 *  The enricher is the one collaborator that spends a token, so a test chooses its answer
 *  (and its failure). */
function setup(
  note = [
    "---",
    "updatedAt: 2026-08-01T10:00:00Z",
    "---",
    "## Things to do",
    "- [ ] Buy cat sand #type/todo [start:: 2026-08-28] [due:: 2026-09-02]",
    "- [x] finish the book #type/todo [due:: 2026-06-14] [completion:: 2026-06-23]",
  ].join("\n"),
) {
  const sent: Sent[] = [];
  const edited: Edited[] = [];
  const deleted: number[] = [];
  const notices: string[] = [];
  let nextId = 100;
  const telegram = { down: false };
  const refuse = () => {
    if (telegram.down) throw new Error("telegram is down");
  };
  const notifier = {
    notify: async (text: string) => void notices.push(text),
    send: async (text: string, opts?: unknown) => {
      refuse();
      sent.push({ text, opts });
      return nextId++;
    },
    edit: async (id: number, text: string, opts?: unknown) => {
      refuse();
      edited.push({ id, text, opts });
    },
    delete: async (id: number) => {
      refuse();
      deleted.push(id);
    },
  };

  const drafts = new Map<string, any>();
  const settings = new Map<string, string>();
  const repo = {
    insertTaskDraft: async (row: any) => void drafts.set(row.id, { ...row }),
    getTaskDraft: async (id: string) => drafts.get(id),
    updateTaskDraft: async (id: string, patch: any) =>
      void drafts.set(id, { ...drafts.get(id), ...patch }),
    claimTaskDraft: async (id: string) => {
      const draft = drafts.get(id);
      if (draft?.status !== "pending") return false;
      drafts.set(id, { ...draft, status: "created" });
      return true;
    },
    taskDraftsForJot: async (jotId: string) =>
      [...drafts.values()].filter((draft) => draft.jot_id === jotId).length,
    ...new FakeSettings(settings),
  };

  const vault = { content: note };
  let broken = false;
  const obsidian: any = {
    readNote: async () => {
      if (broken) throw new Error("obsidian is down");
      return vault.content;
    },
    writeNote: async (_path: string, content: string) => {
      vault.content = content;
    },
    ...noteOps(() => obsidian),
  };
  const notes = new TaskNoteRepository(obsidian, {
    work: {
      path: "work.md",
      heading: "Other Tasks",
      tag: "#type/todo/work",
      insert: "top",
    },
    personal: {
      path: "personal.md",
      heading: "Things to do",
      tag: "#type/todo",
      insert: "bottom",
    },
  });
  let extract: (text: string) => Promise<any> = async (text) => ({
    description: text,
    type: "personal",
  });
  const modes = new Modes(notifier);
  const tasks = new TaskService({
    repo,
    settings: repo,
    notes,
    enricher: { extractTask: (text: string) => extract(text) },
    notifier,
    modes,
    ownerId: OWNER,
    voice: { transcribe: async () => "" },
  });
  const buttons = (opts?: any): string[] =>
    (opts?.keyboard?.inline_keyboard ?? [])
      .flat()
      .map((button: any) => button.callback_data);
  return {
    tasks,
    sent,
    edited,
    deleted,
    notices,
    drafts,
    vault,
    settings,
    modes,
    telegram,
    buttons,
    live: async (id: string) =>
      (await tasks.live(id)) as unknown as TaskDraftRow,
    breakReads: () => {
      broken = true;
    },
    setExtract: (fn: (text: string) => Promise<any>) => {
      extract = fn;
    },
  };
}

const draftId = (drafts: Map<string, any>) => [...drafts.keys()][0]!;

/** Press a list row the way its view does: the callback data names the task and the digest
 *  of the line it was drawn from. */
function press(harness: { tasks: TaskService }, data: string) {
  const [, action, type, index, fingerprint] = data.split(":");
  return harness.tasks.tick(
    type as TaskType,
    Number(index),
    fingerprint!,
    action === "k",
  );
}

test("a message in task mode becomes a draft on a card, not a task in the note", async () => {
  const harness = setup();
  const before = harness.vault.content;
  assert.equal(await harness.tasks.handle("buy cat sand next week"), true);
  assert.equal(harness.drafts.size, 1);
  const draft = harness.drafts.get(draftId(harness.drafts));
  assert.equal(draft.description, "buy cat sand");
  assert.equal(draft.status, "pending");
  assert.equal(draft.type, "personal");
  assert.equal(draft.chat_id, OWNER);
  assert.equal(harness.vault.content, before); // nothing written until Create
  const card = harness.sent.at(-1)!;
  assert.match(card.text, /📝 New task/);
  assert.match(card.text, /buy cat sand/);
  assert.equal(card.opts.html, true);
  assert.deepEqual(harness.buttons(card.opts), [
    `tk:d:${draft.id}`,
    `tk:t:${draft.id}`,
    `tk:s:${draft.id}`,
    `tk:u:${draft.id}`,
    `tk:ok:${draft.id}`,
    `tk:x:${draft.id}`,
  ]);
  assert.equal(draft.message_id, 100); // so the card can be edited in place later
});

test("a message with nothing to do is refused instead of drafted", async () => {
  const harness = setup();
  assert.equal(await harness.tasks.handle("next week"), false);
  assert.equal(harness.drafts.size, 0);
  assert.deepEqual(harness.sent, []);
});

test("the type button toggles, and Create writes the task into its note", async () => {
  const harness = setup();
  await harness.tasks.handle("review the RFC by next friday");
  const id = draftId(harness.drafts);
  await harness.tasks.setType(await harness.live(id), "work");
  assert.equal(harness.drafts.get(id).type, "work");
  assert.match(harness.edited.at(-1)!.text, /Type: 🏢 Work/);
  await harness.tasks.setType(await harness.live(id), "personal");
  assert.equal(harness.drafts.get(id).type, "personal");

  const row = await harness.live(id);
  assert.equal(await harness.tasks.claim(row), "claimed");
  await harness.tasks.create(row);
  assert.match(
    harness.vault.content,
    /- \[ \] review the RFC \(from \[\[\d{4}-\d{2}-\d{2}\]\]\) #type\/todo/,
  );
  assert.match(harness.edited.at(-1)!.text, /✅ Added to 🏠 Personal/);
  assert.deepEqual(harness.edited.at(-1)!.opts.keyboard.inline_keyboard, []); // no buttons left
});

test("a write that fails hands the draft back, redraws the card and says why", async () => {
  const harness = setup();
  await harness.tasks.handle("review the RFC by next friday");
  const id = draftId(harness.drafts);
  const row = await harness.live(id);
  await harness.tasks.claim(row);
  harness.breakReads();
  await harness.tasks.create(row);
  assert.equal(harness.drafts.get(id).status, "pending");
  assert.match(harness.edited.at(-1)!.text, /📝 New task/);
  assert.deepEqual(harness.notices, [
    "⚠️ Couldn't write that task: obsidian is down",
  ]);
});

test("a task with no deadline cannot be created and nothing is claimed", async () => {
  const harness = setup();
  await harness.tasks.handle("buy milk");
  const id = draftId(harness.drafts);
  assert.equal(await harness.tasks.claim(await harness.live(id)), "noDue");
  assert.equal(harness.drafts.get(id).status, "pending");
});

test("two fast taps on Create claim the draft once", async () => {
  const harness = setup();
  await harness.tasks.handle("buy cat sand next week");
  const row = await harness.live(draftId(harness.drafts));
  const outcomes = await Promise.all([
    harness.tasks.claim(row),
    harness.tasks.claim(row),
  ]);
  assert.deepEqual(outcomes.sort(), ["claimed", "lost"]);
});

test("a settled or unknown draft answers the tap with a toast instead of a row", async () => {
  const harness = setup();
  await harness.tasks.handle("buy cat sand next week");
  const id = draftId(harness.drafts);
  await harness.tasks.drop(await harness.live(id));
  assert.equal(harness.drafts.get(id).status, "cancelled");
  assert.equal(await harness.tasks.live(id), "already cancelled");
  assert.equal(await harness.tasks.live("nosuchid"), "expired");
  assert.equal(await harness.tasks.live(undefined), "expired");
});

test("a reply to a date prompt is read, and a bad one is refused", async () => {
  const harness = setup();
  await harness.tasks.handle("buy milk");
  const id = draftId(harness.drafts);
  const ref = { field: "u", id } as const;

  assert.equal(await harness.tasks.answer(ref, "2026-09-15", 99), "ok");
  assert.equal(harness.drafts.get(id).due, "2026-09-15");
  assert.match(harness.edited.at(-1)!.text, /Due: 2026-09-15/);

  assert.equal(await harness.tasks.answer(ref, "banana", 99), "badDate");
  assert.equal(harness.drafts.get(id).due, "2026-09-15");

  // The deadline is the mandatory one, so it can't be cleared.
  assert.equal(await harness.tasks.answer(ref, "none", 99), "needsDue");
  assert.equal(harness.drafts.get(id).due, "2026-09-15");

  // The start date can be: it falls back to the deadline.
  assert.equal(
    await harness.tasks.answer({ field: "s", id }, "none", 99),
    "ok",
  );
  assert.equal(harness.drafts.get(id).start, null);
});

test("a reply to the description prompt rewrites it, and an empty one is refused", async () => {
  const harness = setup();
  await harness.tasks.handle("buy milk");
  const id = draftId(harness.drafts);
  assert.equal(
    await harness.tasks.answer({ field: "d", id }, "", 99),
    "noText",
  );
  assert.equal(harness.drafts.get(id).description, "buy milk");
  assert.equal(
    await harness.tasks.answer({ field: "d", id }, "buy oat milk", 99),
    "ok",
  );
  assert.equal(harness.drafts.get(id).description, "buy oat milk");
});

test("a reply for a draft that is already settled changes nothing", async () => {
  const harness = setup();
  await harness.tasks.handle("buy milk");
  const id = draftId(harness.drafts);
  await harness.tasks.drop(await harness.live(id));
  assert.equal(
    await harness.tasks.answer({ field: "u", id }, "2026-09-15", 99),
    "settled",
  );
  assert.equal(
    await harness.tasks.answer(
      { field: "u", id: "nosuchid" },
      "2026-09-15",
      99,
    ),
    "settled",
  );
  assert.equal(harness.drafts.get(id).due, null);
});

test("an answered prompt is taken back out of the chat, an unanswerable one stays", async () => {
  const harness = setup();
  await harness.tasks.handle("buy milk");
  const id = draftId(harness.drafts);
  await harness.tasks.ask(await harness.live(id), "u", true);
  const promptId = 101; // the card is 100
  const ref = { field: "u", id } as const;

  // A date it can't read leaves the question standing: there'd be nothing to reply to.
  await harness.tasks.answer(ref, "banana", promptId);
  assert.deepEqual(harness.deleted, []);

  await harness.tasks.answer(ref, "next friday", promptId);
  assert.deepEqual(harness.deleted, [promptId]);
});

test("settling a card clears the questions still hanging off it", async () => {
  const harness = setup();
  await harness.tasks.suggest(
    { description: "Call the vet", type: "personal", start: null, due: null },
    "jot12345",
    "2026-08-20",
  );
  const id = draftId(harness.drafts);
  // The suggestion asked for a deadline; dropping the card takes the question with it.
  assert.match(harness.sent.at(-1)!.text, /with the due date/);
  await harness.tasks.drop(await harness.live(id));
  assert.deepEqual(harness.deleted, [101]);
  assert.equal(harness.drafts.get(id).status, "dismissed");
  assert.match(harness.edited.at(-1)!.text, /Not a task/);
  assert.deepEqual(harness.edited.at(-1)!.opts.keyboard.inline_keyboard, []);
});

test("a suggestion from a jot carries the jot's day and asks for a missing deadline", async () => {
  const harness = setup();
  await harness.tasks.suggest(
    { description: "Call the vet", type: "personal", start: null, due: null },
    "jot12345",
    "2026-08-20",
  );
  const draft = harness.drafts.get(draftId(harness.drafts));
  assert.equal(draft.source, "jot");
  assert.equal(draft.jot_id, "jot12345");
  assert.equal(draft.source_date, "2026-08-20");
  assert.match(harness.sent[0]!.text, /That sounds like a task/);
  // Its cancel button dismisses rather than drops, and the deadline is asked for outright.
  assert.equal(
    harness.sent[0]!.opts.keyboard.inline_keyboard.flat().at(-1).text,
    "🚫 Not a task",
  );
  assert.match(harness.sent[1]!.text, /with the due date/);
});

test("a suggestion that already has a deadline asks nothing", async () => {
  const harness = setup();
  await harness.tasks.suggest(
    {
      description: "Call the vet",
      type: "personal",
      start: null,
      due: "2026-08-25",
    },
    "jot12345",
    "2026-08-20",
  );
  assert.equal(harness.sent.length, 1);
});

const detected = [
  { description: "Call the vet tomorrow", type: "personal" as const },
  {
    description: "Answer the RFC",
    due: "next friday",
    type: "work" as const,
  },
];

test("detected tasks become drafts dated from the jot's own day", async () => {
  const harness = setup();
  // The jot's note is 2026-08-16 (a Sunday), so "tomorrow" is the day after the entry,
  // not the day it happens to be processed.
  assert.deepEqual(
    await harness.tasks.draftsFor(detected, "jot12345", "2026-08-16"),
    [
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
    ],
  );
});

test("detection can be switched off, and never asks about the same jot twice", async () => {
  const off = setup();
  off.settings.set("taskDetection", "off");
  assert.deepEqual(
    await off.tasks.draftsFor(detected, "jot12345", "2026-08-16"),
    [],
  );

  // A jot that already produced drafts was asked about once: /reprocess must not ask
  // again about tasks that were created, or dismissed, weeks ago.
  const asked = setup();
  await asked.tasks.suggest(
    { description: "Call the vet", type: "personal", start: null, due: null },
    "jot12345",
    "2026-08-16",
  );
  assert.deepEqual(
    await asked.tasks.draftsFor(detected, "jot12345", "2026-08-16"),
    [],
  );

  const none = setup();
  assert.deepEqual(
    await none.tasks.draftsFor([], "jot12345", "2026-08-16"),
    [],
  );
  assert.deepEqual(
    await none.tasks.draftsFor(undefined as never, "jot12345", "2026-08-16"),
    [],
  );
});

test("a card that cannot be sent leaves the draft without a message and the next edit sends a fresh card", async () => {
  const harness = setup();
  harness.telegram.down = true;
  await harness.tasks.handle("buy milk");
  const id = draftId(harness.drafts);
  assert.equal(harness.drafts.get(id).message_id, null);
  harness.telegram.down = false;
  await harness.tasks.setType(await harness.live(id), "work");
  assert.match(harness.sent.at(-1)!.text, /Type: 🏢 Work/);
});

test("Telegram refusing an edit or a delete does not stop the flow or lose the change", async () => {
  const harness = setup();
  await harness.tasks.handle("buy milk");
  const id = draftId(harness.drafts);
  await harness.tasks.ask(await harness.live(id), "u", true);
  harness.telegram.down = true;

  await harness.tasks.setType(await harness.live(id), "work");
  assert.equal(harness.drafts.get(id).type, "work");

  // The answer is kept even though neither the prompt delete nor the card edit goes through.
  const ref = { field: "u", id } as const;
  assert.equal(await harness.tasks.answer(ref, "2026-09-15", 101), "ok");
  assert.equal(harness.drafts.get(id).due, "2026-09-15");

  await harness.tasks.drop(await harness.live(id));
  assert.equal(harness.drafts.get(id).status, "cancelled");
  assert.deepEqual(harness.deleted, []);
  assert.deepEqual(harness.edited, []);
});

test("a list ticks the task it points at and redraws itself", async () => {
  const harness = setup();
  const list = await harness.tasks.list("open", 0);
  assert.match(list.text, /📋 All open tasks/);
  assert.match(list.text, /1\. ☐ Buy cat sand · due 2026-09-02/);
  const [tick] = list.keyboard.inline_keyboard[0]!;
  assert.match(tick!.callback_data, /^tk:k:personal:0:[0-9a-f]{8}:open:0$/);

  await press(harness, tick!.callback_data);
  assert.match(
    harness.vault.content,
    /- \[x\] Buy cat sand .*\[completion:: \d{4}-\d{2}-\d{2}\]/,
  );
  assert.match((await harness.tasks.list("open", 0)).text, /Nothing here\./);
  assert.deepEqual(harness.notices, []);
});

test("a tick whose note moved underneath is refused and the owner told", async () => {
  const harness = setup();
  const list = await harness.tasks.list("open", 0);
  harness.vault.content = harness.vault.content.replace(
    "Buy cat sand",
    "Buy something else",
  );
  await press(harness, list.keyboard.inline_keyboard[0]![0]!.callback_data);
  assert.match(harness.vault.content, /- \[ \] Buy something else/); // not ticked
  assert.match(harness.notices.at(-1)!, /moved or changed in Obsidian/);
});

test("the done list reopens a task instead of ticking it", async () => {
  const harness = setup();
  const list = await harness.tasks.list("done", 0);
  const [reopen] = list.keyboard.inline_keyboard[0]!;
  assert.match(reopen!.callback_data, /^tk:r:personal:1:[0-9a-f]{8}:done:0$/);
  await press(harness, reopen!.callback_data);
  assert.match(
    harness.vault.content,
    /- \[ \] finish the book #type\/todo \[due:: 2026-06-14\]$/m,
  );
});

test("a list pages eight rows at a time, with Prev and Next only where a page exists, and exactly one Close", async () => {
  const rows = Array.from(
    { length: 10 },
    (_row, index) => `- [ ] Task ${index} #type/todo [due:: 2026-09-0${index}]`,
  );
  const harness = setup(["## Things to do", ...rows].join("\n"));
  const nav = async (page: number) =>
    (await harness.tasks.list("open", page)).keyboard.inline_keyboard
      .flat()
      .map((button) => button.callback_data)
      .filter((data) => !/^tk:[kr]:/.test(data));

  assert.deepEqual(await nav(0), ["tk:v:open:1", "tk:m", "tk:close"]);
  assert.deepEqual(await nav(1), ["tk:v:open:0", "tk:m", "tk:close"]);
  const first = await harness.tasks.list("open", 0);
  assert.match(first.text, /10 tasks · page 1\/2 · tap one to tick it off/);
  assert.equal(first.keyboard.inline_keyboard.length, 8 + 3);
  assert.match((await harness.tasks.list("open", 1)).text, /9\. ☐ Task 8/); // numbering carries on
});

test("a list that cannot read the notes rejects so the caller can say so", async () => {
  const harness = setup();
  harness.breakReads();
  await assert.rejects(harness.tasks.list("open", 0), /obsidian is down/);
});

test("the morning summary is dated, and its rows tick straight through", async () => {
  const today = new Date();
  const iso = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  const harness = setup(
    [
      "---",
      "updatedAt: 2026-08-01T10:00:00Z",
      "---",
      "## Things to do",
      `- [ ] Pay the invoice #type/todo [due:: ${iso(yesterday)}]`,
      `- [ ] Buy cat sand #type/todo [due:: ${iso(today)}]`,
      "- [ ] Something far off #type/todo [due:: 2099-01-01]",
      "- [x] finish the book #type/todo [due:: 2026-06-14] [completion:: 2026-06-23]",
    ].join("\n"),
  );

  await harness.tasks.dailySummary();
  const sent = harness.sent.at(-1)!;
  assert.match(sent.text, new RegExp(`🌅 Your tasks for ${iso(today)}`));
  // What's on the plate: due today plus what's still hanging over. Not the far-off one,
  // and not the finished one.
  assert.match(sent.text, /Pay the invoice/);
  assert.match(sent.text, /Buy cat sand/);
  assert.doesNotMatch(sent.text, /Something far off/);
  assert.doesNotMatch(sent.text, /finish the book/);
  assert.equal(sent.opts.silent, false);

  // The rows are the same tickable buttons the lists use.
  const [first] = harness.buttons(sent.opts);
  assert.match(first!, /^tk:k:personal:0:[0-9a-f]{8}:day:0$/);
  await press(harness, first!);
  assert.match(
    harness.vault.content,
    /- \[x\] Pay the invoice .*\[completion:: \d{4}-\d{2}-\d{2}\]/,
  );
});

test("a day with nothing due sends nothing at all", async () => {
  const harness = setup(
    [
      "## Things to do",
      "- [ ] Something far off #type/todo [due:: 2099-01-01]",
      "- [x] finish the book #type/todo [due:: 2026-06-14] [completion:: 2026-06-23]",
    ].join("\n"),
  );
  await harness.tasks.dailySummary();
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(harness.notices, []);
});

test("a summary that can't read the notes still says so, loudly", async () => {
  const harness = setup();
  harness.breakReads();
  await harness.tasks.dailySummary();
  assert.deepEqual(harness.sent, [
    {
      text: "⚠️ Couldn't put together your task summary: obsidian is down",
      opts: { silent: false },
    },
  ]);
});

test("/taskadd reads one line through the enricher and shows the card", async () => {
  const harness = setup();
  harness.setExtract(async () => ({
    description: "Answer Pavlo about the Hive review",
    due: "next friday",
    type: "work",
  }));
  assert.equal(
    await harness.tasks.quickAdd("gotta answer pavlo re hive by next friday"),
    true,
  );
  const draft = harness.drafts.get(draftId(harness.drafts));
  assert.equal(draft.description, "Answer Pavlo about the Hive review");
  assert.equal(draft.type, "work");
  assert.match(draft.due, /^\d{4}-\d{2}-\d{2}$/); // the phrase was resolved, not stored
  assert.equal(draft.status, "pending");
  assert.match(harness.sent.at(-1)!.text, /Answer Pavlo about the Hive review/);
});

test("/taskadd falls back to the token-free parser when the model is down", async () => {
  const harness = setup();
  harness.setExtract(async () => {
    throw new Error("usage exhausted");
  });
  assert.equal(await harness.tasks.quickAdd("buy cat sand next week"), true);
  const draft = harness.drafts.get(draftId(harness.drafts));
  assert.equal(draft.description, "buy cat sand");
  assert.match(draft.due, /^\d{4}-\d{2}-\d{2}$/);
});

test("/taskadd with no timing asks for the deadline straight away, and a line with no task is refused", async () => {
  const harness = setup();
  harness.setExtract(async () => ({
    description: "Renew the passport",
    type: "personal",
  }));
  assert.equal(await harness.tasks.quickAdd("renew the passport"), true);
  assert.equal(harness.drafts.get(draftId(harness.drafts)).due, null);
  assert.match(harness.sent.at(-1)!.text, /with the due date/);

  harness.setExtract(async () => ({ description: " ", type: "personal" }));
  assert.equal(await harness.tasks.quickAdd("   "), false);
  assert.equal(harness.drafts.size, 1);
});

test("the reply to a bare /taskadd is the task, and its prompt leaves the chat", async () => {
  const harness = setup();
  harness.setExtract(async () => ({
    description: "Renew the passport",
    due: "next friday",
    type: "personal",
  }));
  const add = { field: "add" } as const;
  assert.equal(await harness.tasks.answer(add, "", 55), "noTask");
  assert.deepEqual(harness.deleted, []);
  assert.equal(
    await harness.tasks.answer(add, "renew the passport next friday", 55),
    "ok",
  );
  assert.deepEqual(harness.deleted, [55]);
  assert.equal(harness.drafts.size, 1);

  harness.setExtract(async () => ({ description: " ", type: "personal" }));
  assert.equal(await harness.tasks.answer(add, "???", 56), "nothing");
});

test("a question nobody asked for never grabs the compose box, one from a button does", async () => {
  // A force_reply on an unasked question is how a message meant for the journal ends up
  // sent as a date.
  const harness = setup();
  await harness.tasks.suggest(
    { description: "Call the vet", type: "personal", start: null, due: null },
    "jot12345",
    "2026-08-20",
  );
  assert.equal(harness.sent.at(-1)!.opts, undefined);

  harness.setExtract(async () => ({
    description: "Renew the passport",
    type: "personal",
  }));
  await harness.tasks.quickAdd("renew the passport");
  assert.equal(harness.sent.at(-1)!.opts, undefined);

  await harness.tasks.handle("buy milk");
  await harness.tasks.ask(
    await harness.live([...harness.drafts.keys()].at(-1)!),
    "u",
    true,
  );
  assert.deepEqual(harness.sent.at(-1)!.opts, { forceReply: true });
});

test("the task menu lists every screen and shows both detection switches, on by default", async () => {
  const harness = setup();
  const menu = await harness.tasks.menu();
  const rows = menu.keyboard.inline_keyboard;
  assert.equal(rows.length, 7 + 3);
  assert.deepEqual(
    rows.slice(-3).map((row) => row.map((button) => button.callback_data)),
    [["tk:det"], ["tk:til"], ["tk:close"]],
  );
  assert.match(rows.at(-3)![0]!.text, /Spot tasks in jots: on$/);
  assert.match(rows.at(-2)![0]!.text, /Spot TILs in jots: on$/);
  assert.match(menu.text, /🗂 Tasks/);

  await harness.tasks.promptRoot();
  assert.deepEqual(harness.sent.at(-1)!.opts.keyboard, menu.keyboard);
});

test("the TIL and task detection switches toggle both ways and do not touch each other", async () => {
  const harness = setup();
  assert.equal(await harness.tasks.toggle("tilDetection"), false);
  assert.equal(harness.settings.get("tilDetection"), "off");
  assert.equal(harness.settings.has("taskDetection"), false);
  assert.match(
    (await harness.tasks.menu()).keyboard.inline_keyboard.at(-2)![0]!.text,
    /Spot TILs in jots: off$/,
  );

  assert.equal(await harness.tasks.toggle("taskDetection"), false);
  assert.equal(harness.settings.get("taskDetection"), "off");
  assert.equal(harness.settings.get("tilDetection"), "off");
  assert.equal(await harness.tasks.toggle("tilDetection"), true);
  assert.equal(harness.settings.get("tilDetection"), "on");
});

test("task mode follows the modes owner: on and off, refused while command mode is open", () => {
  const harness = setup();
  assert.equal(harness.tasks.isOpen(), false);
  assert.equal(harness.tasks.start(), "opened");
  assert.equal(harness.tasks.isOpen(), true);
  assert.equal(harness.tasks.start(), "already");
  harness.modes.close();
  assert.equal(harness.tasks.isOpen(), false);
  harness.modes.open("command");
  assert.equal(harness.tasks.start(), "busy");
  assert.equal(harness.tasks.isOpen(), false);
});
