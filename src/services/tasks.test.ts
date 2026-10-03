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
    insertTaskDraft: async (d: any) => void drafts.set(d.id, { ...d }),
    getTaskDraft: async (id: string) => drafts.get(id),
    updateTaskDraft: async (id: string, patch: any) =>
      void drafts.set(id, { ...drafts.get(id), ...patch }),
    claimTaskDraft: async (id: string) => {
      const d = drafts.get(id);
      if (d?.status !== "pending") return false;
      drafts.set(id, { ...d, status: "created" });
      return true;
    },
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
    repo: repo as any,
    settings: repo as any,
    notes,
    enricher: { extractTask: (text: string) => extract(text) } as any,
    notifier,
    modes,
    ownerId: OWNER,
    voice: { transcribe: async () => "" },
  });
  const buttons = (opts?: any): string[] =>
    (opts?.keyboard?.inline_keyboard ?? [])
      .flat()
      .map((b: any) => b.callback_data);
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
function press(h: { tasks: TaskService }, data: string) {
  const [, action, type, index, fingerprint] = data.split(":");
  return h.tasks.tick(
    type as TaskType,
    Number(index),
    fingerprint!,
    action === "k",
  );
}

test("a message in task mode becomes a draft on a card, not a task in the note", async () => {
  const h = setup();
  const before = h.vault.content;
  assert.equal(await h.tasks.handle("buy cat sand next week"), true);
  assert.equal(h.drafts.size, 1);
  const d = h.drafts.get(draftId(h.drafts));
  assert.equal(d.description, "buy cat sand");
  assert.equal(d.status, "pending");
  assert.equal(d.type, "personal");
  assert.equal(d.chat_id, OWNER);
  assert.equal(h.vault.content, before); // nothing written until Create
  const card = h.sent.at(-1)!;
  assert.match(card.text, /📝 New task/);
  assert.match(card.text, /buy cat sand/);
  assert.equal(card.opts.html, true);
  assert.deepEqual(h.buttons(card.opts), [
    `tk:d:${d.id}`,
    `tk:t:${d.id}`,
    `tk:s:${d.id}`,
    `tk:u:${d.id}`,
    `tk:ok:${d.id}`,
    `tk:x:${d.id}`,
  ]);
  assert.equal(d.message_id, 100); // so the card can be edited in place later
});

test("a message with nothing to do is refused instead of drafted", async () => {
  const h = setup();
  assert.equal(await h.tasks.handle("next week"), false);
  assert.equal(h.drafts.size, 0);
  assert.deepEqual(h.sent, []);
});

test("the type button toggles, and Create writes the task into its note", async () => {
  const h = setup();
  await h.tasks.handle("review the RFC by next friday");
  const id = draftId(h.drafts);
  await h.tasks.setType(await h.live(id), "work");
  assert.equal(h.drafts.get(id).type, "work");
  assert.match(h.edited.at(-1)!.text, /Type: 🏢 Work/);
  await h.tasks.setType(await h.live(id), "personal");
  assert.equal(h.drafts.get(id).type, "personal");

  const row = await h.live(id);
  assert.equal(await h.tasks.claim(row), "claimed");
  await h.tasks.create(row);
  assert.match(
    h.vault.content,
    /- \[ \] review the RFC \(from \[\[\d{4}-\d{2}-\d{2}\]\]\) #type\/todo/,
  );
  assert.match(h.edited.at(-1)!.text, /✅ Added to 🏠 Personal/);
  assert.deepEqual(h.edited.at(-1)!.opts.keyboard.inline_keyboard, []); // no buttons left
});

test("a write that fails hands the draft back, redraws the card and says why", async () => {
  const h = setup();
  await h.tasks.handle("review the RFC by next friday");
  const id = draftId(h.drafts);
  const row = await h.live(id);
  await h.tasks.claim(row);
  h.breakReads();
  await h.tasks.create(row);
  assert.equal(h.drafts.get(id).status, "pending");
  assert.match(h.edited.at(-1)!.text, /📝 New task/);
  assert.deepEqual(h.notices, ["⚠️ Couldn't write that task: obsidian is down"]);
});

test("a task with no deadline cannot be created and nothing is claimed", async () => {
  const h = setup();
  await h.tasks.handle("buy milk");
  const id = draftId(h.drafts);
  assert.equal(await h.tasks.claim(await h.live(id)), "noDue");
  assert.equal(h.drafts.get(id).status, "pending");
});

test("two fast taps on Create claim the draft once", async () => {
  const h = setup();
  await h.tasks.handle("buy cat sand next week");
  const row = await h.live(draftId(h.drafts));
  const outcomes = await Promise.all([h.tasks.claim(row), h.tasks.claim(row)]);
  assert.deepEqual(outcomes.sort(), ["claimed", "lost"]);
});

test("a settled or unknown draft answers the tap with a toast instead of a row", async () => {
  const h = setup();
  await h.tasks.handle("buy cat sand next week");
  const id = draftId(h.drafts);
  await h.tasks.drop(await h.live(id));
  assert.equal(h.drafts.get(id).status, "cancelled");
  assert.equal(await h.tasks.live(id), "already cancelled");
  assert.equal(await h.tasks.live("nosuchid"), "expired");
  assert.equal(await h.tasks.live(undefined), "expired");
});

test("a reply to a date prompt is read, and a bad one is refused", async () => {
  const h = setup();
  await h.tasks.handle("buy milk");
  const id = draftId(h.drafts);
  const ref = { field: "u", id } as const;

  assert.equal(await h.tasks.answer(ref, "2026-09-15", 99), "ok");
  assert.equal(h.drafts.get(id).due, "2026-09-15");
  assert.match(h.edited.at(-1)!.text, /Due: 2026-09-15/);

  assert.equal(await h.tasks.answer(ref, "banana", 99), "badDate");
  assert.equal(h.drafts.get(id).due, "2026-09-15");

  // The deadline is the mandatory one, so it can't be cleared.
  assert.equal(await h.tasks.answer(ref, "none", 99), "needsDue");
  assert.equal(h.drafts.get(id).due, "2026-09-15");

  // The start date can be: it falls back to the deadline.
  assert.equal(await h.tasks.answer({ field: "s", id }, "none", 99), "ok");
  assert.equal(h.drafts.get(id).start, null);
});

test("a reply to the description prompt rewrites it, and an empty one is refused", async () => {
  const h = setup();
  await h.tasks.handle("buy milk");
  const id = draftId(h.drafts);
  assert.equal(await h.tasks.answer({ field: "d", id }, "", 99), "noText");
  assert.equal(h.drafts.get(id).description, "buy milk");
  assert.equal(
    await h.tasks.answer({ field: "d", id }, "buy oat milk", 99),
    "ok",
  );
  assert.equal(h.drafts.get(id).description, "buy oat milk");
});

test("a reply for a draft that is already settled changes nothing", async () => {
  const h = setup();
  await h.tasks.handle("buy milk");
  const id = draftId(h.drafts);
  await h.tasks.drop(await h.live(id));
  assert.equal(
    await h.tasks.answer({ field: "u", id }, "2026-09-15", 99),
    "settled",
  );
  assert.equal(
    await h.tasks.answer({ field: "u", id: "nosuchid" }, "2026-09-15", 99),
    "settled",
  );
  assert.equal(h.drafts.get(id).due, null);
});

test("an answered prompt is taken back out of the chat, an unanswerable one stays", async () => {
  const h = setup();
  await h.tasks.handle("buy milk");
  const id = draftId(h.drafts);
  await h.tasks.ask(await h.live(id), "u", true);
  const promptId = 101; // the card is 100
  const ref = { field: "u", id } as const;

  // A date it can't read leaves the question standing: there'd be nothing to reply to.
  await h.tasks.answer(ref, "banana", promptId);
  assert.deepEqual(h.deleted, []);

  await h.tasks.answer(ref, "next friday", promptId);
  assert.deepEqual(h.deleted, [promptId]);
});

test("settling a card clears the questions still hanging off it", async () => {
  const h = setup();
  await h.tasks.suggest(
    { description: "Call the vet", type: "personal", start: null, due: null },
    "jot12345",
    "2026-08-20",
  );
  const id = draftId(h.drafts);
  // The suggestion asked for a deadline; dropping the card takes the question with it.
  assert.match(h.sent.at(-1)!.text, /with the due date/);
  await h.tasks.drop(await h.live(id));
  assert.deepEqual(h.deleted, [101]);
  assert.equal(h.drafts.get(id).status, "dismissed");
  assert.match(h.edited.at(-1)!.text, /Not a task/);
  assert.deepEqual(h.edited.at(-1)!.opts.keyboard.inline_keyboard, []);
});

test("a suggestion from a jot carries the jot's day and asks for a missing deadline", async () => {
  const h = setup();
  await h.tasks.suggest(
    { description: "Call the vet", type: "personal", start: null, due: null },
    "jot12345",
    "2026-08-20",
  );
  const d = h.drafts.get(draftId(h.drafts));
  assert.equal(d.source, "jot");
  assert.equal(d.jot_id, "jot12345");
  assert.equal(d.source_date, "2026-08-20");
  assert.match(h.sent[0]!.text, /That sounds like a task/);
  // Its cancel button dismisses rather than drops, and the deadline is asked for outright.
  assert.equal(
    h.sent[0]!.opts.keyboard.inline_keyboard.flat().at(-1).text,
    "🚫 Not a task",
  );
  assert.match(h.sent[1]!.text, /with the due date/);
});

test("a suggestion that already has a deadline asks nothing", async () => {
  const h = setup();
  await h.tasks.suggest(
    {
      description: "Call the vet",
      type: "personal",
      start: null,
      due: "2026-08-25",
    },
    "jot12345",
    "2026-08-20",
  );
  assert.equal(h.sent.length, 1);
});

test("a card that cannot be sent leaves the draft without a message and the next edit sends a fresh card", async () => {
  const h = setup();
  h.telegram.down = true;
  await h.tasks.handle("buy milk");
  const id = draftId(h.drafts);
  assert.equal(h.drafts.get(id).message_id, null);
  h.telegram.down = false;
  await h.tasks.setType(await h.live(id), "work");
  assert.match(h.sent.at(-1)!.text, /Type: 🏢 Work/);
});

test("Telegram refusing an edit or a delete does not stop the flow or lose the change", async () => {
  const h = setup();
  await h.tasks.handle("buy milk");
  const id = draftId(h.drafts);
  await h.tasks.ask(await h.live(id), "u", true);
  h.telegram.down = true;

  await h.tasks.setType(await h.live(id), "work");
  assert.equal(h.drafts.get(id).type, "work");

  // The answer is kept even though neither the prompt delete nor the card edit goes through.
  const ref = { field: "u", id } as const;
  assert.equal(await h.tasks.answer(ref, "2026-09-15", 101), "ok");
  assert.equal(h.drafts.get(id).due, "2026-09-15");

  await h.tasks.drop(await h.live(id));
  assert.equal(h.drafts.get(id).status, "cancelled");
  assert.deepEqual(h.deleted, []);
  assert.deepEqual(h.edited, []);
});

test("a list ticks the task it points at and redraws itself", async () => {
  const h = setup();
  const list = await h.tasks.list("open", 0);
  assert.match(list.text, /📋 All open tasks/);
  assert.match(list.text, /1\. ☐ Buy cat sand · due 2026-09-02/);
  const [tick] = list.keyboard.inline_keyboard[0]!;
  assert.match(tick!.callback_data, /^tk:k:personal:0:[0-9a-f]{8}:open:0$/);

  await press(h, tick!.callback_data);
  assert.match(
    h.vault.content,
    /- \[x\] Buy cat sand .*\[completion:: \d{4}-\d{2}-\d{2}\]/,
  );
  assert.match((await h.tasks.list("open", 0)).text, /Nothing here\./);
  assert.deepEqual(h.notices, []);
});

test("a tick whose note moved underneath is refused and the owner told", async () => {
  const h = setup();
  const list = await h.tasks.list("open", 0);
  h.vault.content = h.vault.content.replace(
    "Buy cat sand",
    "Buy something else",
  );
  await press(h, list.keyboard.inline_keyboard[0]![0]!.callback_data);
  assert.match(h.vault.content, /- \[ \] Buy something else/); // not ticked
  assert.match(h.notices.at(-1)!, /moved or changed in Obsidian/);
});

test("the done list reopens a task instead of ticking it", async () => {
  const h = setup();
  const list = await h.tasks.list("done", 0);
  const [reopen] = list.keyboard.inline_keyboard[0]!;
  assert.match(reopen!.callback_data, /^tk:r:personal:1:[0-9a-f]{8}:done:0$/);
  await press(h, reopen!.callback_data);
  assert.match(
    h.vault.content,
    /- \[ \] finish the book #type\/todo \[due:: 2026-06-14\]$/m,
  );
});

test("a list pages eight rows at a time, with Prev and Next only where a page exists, and exactly one Close", async () => {
  const rows = Array.from(
    { length: 10 },
    (_, i) => `- [ ] Task ${i} #type/todo [due:: 2026-09-0${i}]`,
  );
  const h = setup(["## Things to do", ...rows].join("\n"));
  const nav = async (page: number) =>
    (await h.tasks.list("open", page)).keyboard.inline_keyboard
      .flat()
      .map((b) => b.callback_data)
      .filter((d) => !/^tk:[kr]:/.test(d));

  assert.deepEqual(await nav(0), ["tk:v:open:1", "tk:m", "tk:close"]);
  assert.deepEqual(await nav(1), ["tk:v:open:0", "tk:m", "tk:close"]);
  const first = await h.tasks.list("open", 0);
  assert.match(first.text, /10 tasks · page 1\/2 · tap one to tick it off/);
  assert.equal(first.keyboard.inline_keyboard.length, 8 + 3);
  assert.match((await h.tasks.list("open", 1)).text, /9\. ☐ Task 8/); // numbering carries on
});

test("a list that cannot read the notes rejects so the caller can say so", async () => {
  const h = setup();
  h.breakReads();
  await assert.rejects(h.tasks.list("open", 0), /obsidian is down/);
});

test("the morning summary is dated, and its rows tick straight through", async () => {
  const today = new Date();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  const h = setup(
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

  await h.tasks.dailySummary();
  const sent = h.sent.at(-1)!;
  assert.match(sent.text, new RegExp(`🌅 Your tasks for ${iso(today)}`));
  // What's on the plate: due today plus what's still hanging over. Not the far-off one,
  // and not the finished one.
  assert.match(sent.text, /Pay the invoice/);
  assert.match(sent.text, /Buy cat sand/);
  assert.doesNotMatch(sent.text, /Something far off/);
  assert.doesNotMatch(sent.text, /finish the book/);
  assert.equal(sent.opts.silent, false);

  // The rows are the same tickable buttons the lists use.
  const [first] = h.buttons(sent.opts);
  assert.match(first!, /^tk:k:personal:0:[0-9a-f]{8}:day:0$/);
  await press(h, first!);
  assert.match(
    h.vault.content,
    /- \[x\] Pay the invoice .*\[completion:: \d{4}-\d{2}-\d{2}\]/,
  );
});

test("a day with nothing due sends nothing at all", async () => {
  const h = setup(
    [
      "## Things to do",
      "- [ ] Something far off #type/todo [due:: 2099-01-01]",
      "- [x] finish the book #type/todo [due:: 2026-06-14] [completion:: 2026-06-23]",
    ].join("\n"),
  );
  await h.tasks.dailySummary();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.notices, []);
});

test("a summary that can't read the notes still says so, loudly", async () => {
  const h = setup();
  h.breakReads();
  await h.tasks.dailySummary();
  assert.deepEqual(h.sent, [
    {
      text: "⚠️ Couldn't put together your task summary: obsidian is down",
      opts: { silent: false },
    },
  ]);
});

test("/taskadd reads one line through the enricher and shows the card", async () => {
  const h = setup();
  h.setExtract(async () => ({
    description: "Answer Pavlo about the Hive review",
    due: "next friday",
    type: "work",
  }));
  assert.equal(
    await h.tasks.quickAdd("gotta answer pavlo re hive by next friday"),
    true,
  );
  const d = h.drafts.get(draftId(h.drafts));
  assert.equal(d.description, "Answer Pavlo about the Hive review");
  assert.equal(d.type, "work");
  assert.match(d.due, /^\d{4}-\d{2}-\d{2}$/); // the phrase was resolved, not stored
  assert.equal(d.status, "pending");
  assert.match(h.sent.at(-1)!.text, /Answer Pavlo about the Hive review/);
});

test("/taskadd falls back to the token-free parser when the model is down", async () => {
  const h = setup();
  h.setExtract(async () => {
    throw new Error("usage exhausted");
  });
  assert.equal(await h.tasks.quickAdd("buy cat sand next week"), true);
  const d = h.drafts.get(draftId(h.drafts));
  assert.equal(d.description, "buy cat sand");
  assert.match(d.due, /^\d{4}-\d{2}-\d{2}$/);
});

test("/taskadd with no timing asks for the deadline straight away, and a line with no task is refused", async () => {
  const h = setup();
  h.setExtract(async () => ({
    description: "Renew the passport",
    type: "personal",
  }));
  assert.equal(await h.tasks.quickAdd("renew the passport"), true);
  assert.equal(h.drafts.get(draftId(h.drafts)).due, null);
  assert.match(h.sent.at(-1)!.text, /with the due date/);

  h.setExtract(async () => ({ description: " ", type: "personal" }));
  assert.equal(await h.tasks.quickAdd("   "), false);
  assert.equal(h.drafts.size, 1);
});

test("the reply to a bare /taskadd is the task, and its prompt leaves the chat", async () => {
  const h = setup();
  h.setExtract(async () => ({
    description: "Renew the passport",
    due: "next friday",
    type: "personal",
  }));
  const add = { field: "add" } as const;
  assert.equal(await h.tasks.answer(add, "", 55), "noTask");
  assert.deepEqual(h.deleted, []);
  assert.equal(
    await h.tasks.answer(add, "renew the passport next friday", 55),
    "ok",
  );
  assert.deepEqual(h.deleted, [55]);
  assert.equal(h.drafts.size, 1);

  h.setExtract(async () => ({ description: " ", type: "personal" }));
  assert.equal(await h.tasks.answer(add, "???", 56), "nothing");
});

test("a question nobody asked for never grabs the compose box, one from a button does", async () => {
  // A force_reply on an unasked question is how a message meant for the journal ends up
  // sent as a date.
  const h = setup();
  await h.tasks.suggest(
    { description: "Call the vet", type: "personal", start: null, due: null },
    "jot12345",
    "2026-08-20",
  );
  assert.equal(h.sent.at(-1)!.opts, undefined);

  h.setExtract(async () => ({
    description: "Renew the passport",
    type: "personal",
  }));
  await h.tasks.quickAdd("renew the passport");
  assert.equal(h.sent.at(-1)!.opts, undefined);

  await h.tasks.handle("buy milk");
  await h.tasks.ask(await h.live([...h.drafts.keys()].at(-1)!), "u", true);
  assert.deepEqual(h.sent.at(-1)!.opts, { forceReply: true });
});

test("the task menu lists every screen and shows both detection switches, on by default", async () => {
  const h = setup();
  const menu = await h.tasks.menu();
  const rows = menu.keyboard.inline_keyboard;
  assert.equal(rows.length, 7 + 3);
  assert.deepEqual(
    rows.slice(-3).map((r) => r.map((b) => b.callback_data)),
    [["tk:det"], ["tk:til"], ["tk:close"]],
  );
  assert.match(rows.at(-3)![0]!.text, /Spot tasks in jots: on$/);
  assert.match(rows.at(-2)![0]!.text, /Spot TILs in jots: on$/);
  assert.match(menu.text, /🗂 Tasks/);

  await h.tasks.promptRoot();
  assert.deepEqual(h.sent.at(-1)!.opts.keyboard, menu.keyboard);
});

test("the TIL and task detection switches toggle both ways and do not touch each other", async () => {
  const h = setup();
  assert.equal(await h.tasks.toggle("tilDetection"), false);
  assert.equal(h.settings.get("tilDetection"), "off");
  assert.equal(h.settings.has("taskDetection"), false);
  assert.match(
    (await h.tasks.menu()).keyboard.inline_keyboard.at(-2)![0]!.text,
    /Spot TILs in jots: off$/,
  );

  assert.equal(await h.tasks.toggle("taskDetection"), false);
  assert.equal(h.settings.get("taskDetection"), "off");
  assert.equal(h.settings.get("tilDetection"), "off");
  assert.equal(await h.tasks.toggle("tilDetection"), true);
  assert.equal(h.settings.get("tilDetection"), "on");
});

test("task mode follows the modes owner: on and off, refused while command mode is open", () => {
  const h = setup();
  assert.equal(h.tasks.isOpen(), false);
  assert.equal(h.tasks.start(), "opened");
  assert.equal(h.tasks.isOpen(), true);
  assert.equal(h.tasks.start(), "already");
  h.modes.close();
  assert.equal(h.tasks.isOpen(), false);
  h.modes.open("command");
  assert.equal(h.tasks.start(), "busy");
  assert.equal(h.tasks.isOpen(), false);
});
