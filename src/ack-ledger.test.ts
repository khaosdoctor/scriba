import assert from "node:assert/strict";
import { test } from "node:test";
import { journalLine } from "./core.ts";
import { parseTasks } from "./lib/tasks.ts";
import type { Jot, TaskDraftRow } from "./models/domain.ts";
import {
  botHarness,
  EM,
  type Harness,
  JOT_ID,
  NOW,
  sampleJot,
} from "./test/bot-harness.ts";

// Where each button handler answers the tap (answerCallbackQuery) relative to its vault,
// database and Telegram work, and what the toast says. Each row runs one tap through the
// real bot and renders the ordered calls: `ack(text)` is the answer, `ack!(text)` an
// alert, `repo.*`, `obsidian.*`, `queue.*`, `enricher.*` and `processor.*` are the
// collaborators, `tg.*` the other Telegram calls. An answer that moves relative to the
// work around it, or says something else, breaks its row.

type Row = {
  tap: string;
  when: string;
  setup?: (h: Harness) => void | Promise<void>;
  /** The message the button belongs to; null is a tap that carries none. */
  message?: object | null;
  fail?: string[];
  expect: string;
};

async function actual(rows: Row[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const h = await botHarness();
    await row.setup?.(h);
    for (const method of row.fail ?? []) h.failApi.add(method);
    const run = await h.tap(
      row.tap,
      row.message === undefined ? {} : { message: row.message },
    );
    out[`${row.tap} ${row.when}`] = run.rendered;
  }
  return out;
}

const expected = (rows: Row[]) =>
  Object.fromEntries(rows.map((r) => [`${r.tap} ${r.when}`, r.expect]));

const ledger = (name: string, rows: Row[]) =>
  test(`ack ledger: ${name}`, async () => {
    assert.deepEqual(await actual(rows), expected(rows));
  });

const ID = JOT_ID;
const jot = sampleJot;
const noteWith = (text: string) =>
  `## Journal\n${journalLine("09:58:00", text, ID)}\n`;
const YOUTUBE = "https://youtu.be/abc123";

const withJot =
  (over: Partial<Jot> = {}, note = noteWith("bought milk")) =>
  (h: Harness) => {
    h.repo.getJot = jot(over);
    h.obsidian.readNote = note;
  };

const REMOVED =
  "obsidian.updateNote > obsidian.readNote > obsidian.writeNote > repo.markDeleted > repo.groupFollowers > tg.sendMessage > repo.mapMessage";

// --- namespaces handled by ScribaBot itself ---

ledger("un and dl", [
  {
    tap: `un:${ID}`,
    when: "done jot, answered before the vault write",
    setup: withJot(),
    expect: `repo.getJot > ack(undoing) > ${REMOVED}`,
  },
  {
    tap: `dl:${ID}`,
    when: "failed jot, answered before the vault write",
    setup: withJot({ status: "failed" }),
    expect: `repo.getJot > ack(deleting) > ${REMOVED}`,
  },
  {
    tap: `un:${ID}`,
    when: "jot gone",
    expect: "repo.getJot > ack(gone)",
  },
  { tap: "un:", when: "no id", expect: "ack(gone)" },
  {
    tap: `un:${ID}`,
    when: "already deleted",
    setup: withJot({ status: "deleted" }),
    expect: "repo.getJot > ack(already undone)",
  },
  {
    tap: `dl:${ID}`,
    when: "already deleted",
    setup: withJot({ status: "deleted" }),
    expect: "repo.getJot > ack(already deleted)",
  },
]);

ledger("em", [
  {
    tap: `em:${ID}:1`,
    when: "embed, answered after the vault write",
    setup: withJot({}, noteWith(`watch ${YOUTUBE}`)),
    expect:
      "repo.getJot > obsidian.updateLine > obsidian.readNote > obsidian.writeNote > ack(embedded) > repo.groupFollowers > repo.updateJot > tg.sendMessage > repo.mapMessage",
  },
  {
    tap: `em:${ID}:0`,
    when: "back to a plain link, answered after the vault write",
    setup: withJot({}, noteWith(`watch ![](${YOUTUBE})`)),
    expect:
      "repo.getJot > obsidian.updateLine > obsidian.readNote > obsidian.writeNote > ack(plain link) > repo.groupFollowers > repo.updateJot > tg.sendMessage > repo.mapMessage",
  },
  {
    tap: `em:${ID}:1`,
    when: "jot gone",
    expect: "repo.getJot > ack(gone)",
  },
  {
    tap: `em:${ID}:1`,
    when: "jot not done",
    setup: withJot({ status: "processing" }),
    expect: "repo.getJot > ack(gone)",
  },
  {
    tap: `em:${ID}:1`,
    when: "line missing from the note",
    setup: withJot({}, "## Journal\n"),
    expect:
      "repo.getJot > obsidian.updateLine > obsidian.readNote > ack(line not found)",
  },
]);

ledger("rt", [
  {
    tap: `rt:${ID}`,
    when: "failed jot, answered after the reset and the queue",
    setup: withJot({ status: "failed" }),
    expect:
      "repo.getJot > repo.resetForRetry > queue.add > ack(retrying) > tg.editMessageText",
  },
  { tap: `rt:${ID}`, when: "jot gone", expect: "repo.getJot > ack(gone)" },
  { tap: "rt:", when: "no id", expect: "ack(gone)" },
  {
    tap: `rt:${ID}`,
    when: "jot deleted",
    setup: withJot({ status: "deleted" }),
    expect: `repo.getJot > ack(deleted ${EM} not retrying)`,
  },
]);

ledger("vf", [
  {
    tap: `vf:o:${ID}`,
    when: "keep the original",
    setup: (h) => h.bot.jotController.voiceFixPending.set(ID, () => {}),
    expect: "ack(keeping original)",
  },
  {
    tap: `vf:p:${ID}`,
    when: "use the fixed version",
    setup: (h) => h.bot.jotController.voiceFixPending.set(ID, () => {}),
    expect: "ack(using fixed version)",
  },
  { tap: `vf:o:${ID}`, when: "no pending choice", expect: "ack(expired)" },
  { tap: "vf:o", when: "no jot id", expect: "ack()" },
]);

const REJECTED = [{ surface: "milk", note: "Milk" }];
const withRejected = (h: Harness) => {
  h.repo.rejectionList = REJECTED;
};

ledger("ur", [
  {
    tap: "ur:s:0",
    when: "surface picked",
    setup: withRejected,
    expect: "repo.rejectionList > ack() > tg.editMessageText",
  },
  {
    tap: "ur:p:0:0",
    when: "rejection undone, answered after the write",
    setup: (h) => {
      withRejected(h);
      h.repo.unreject = 1;
    },
    expect:
      "repo.rejectionList > repo.unreject > ack(unrejected) > tg.editMessageText",
  },
  {
    tap: "ur:p:0:0",
    when: "rejection already gone",
    setup: (h) => {
      withRejected(h);
      h.repo.unreject = 0;
    },
    expect:
      "repo.rejectionList > repo.unreject > ack(already gone) > tg.editMessageText",
  },
  {
    tap: "ur:s:0",
    when: "surface out of range",
    expect: "repo.rejectionList > ack(expired)",
  },
  {
    tap: "ur:p:0:3",
    when: "note out of range",
    setup: withRejected,
    expect: "repo.rejectionList > ack(expired)",
  },
  {
    tap: "ur:z:0",
    when: "unknown step",
    setup: withRejected,
    expect: "repo.rejectionList > ack()",
  },
]);

const PENDING_LINK = { surface: "milk", note: "Milk", jot_id: ID };

ledger("lk", [
  {
    tap: "lk:y:p1",
    when: "confirm, answered after the vault write",
    setup: (h) => {
      h.repo.takePendingLink = PENDING_LINK;
      withJot()(h);
    },
    expect:
      "repo.takePendingLink > repo.getJot > obsidian.updateLine > obsidian.readNote > obsidian.writeNote > ack(linked) > tg.editMessageText",
  },
  {
    tap: "lk:n:p1",
    when: "reject, answered after the write",
    setup: (h) => {
      h.repo.takePendingLink = PENDING_LINK;
    },
    expect:
      "repo.takePendingLink > repo.reject > ack(won't link again) > tg.editMessageText",
  },
  {
    tap: "lk:y:p1",
    when: "confirm but the jot is gone",
    setup: (h) => {
      h.repo.takePendingLink = PENDING_LINK;
    },
    expect:
      "repo.takePendingLink > repo.getJot > ack(no change) > tg.editMessageText",
  },
  {
    tap: "lk:y:p1",
    when: "confirm but the word is not on the line",
    setup: (h) => {
      h.repo.takePendingLink = { ...PENDING_LINK, surface: "bread" };
      withJot()(h);
    },
    expect:
      "repo.takePendingLink > repo.getJot > obsidian.updateLine > obsidian.readNote > ack(no change) > tg.editMessageText",
  },
  {
    tap: "lk:y:p1",
    when: "link expired",
    expect: "repo.takePendingLink > ack(expired)",
  },
  { tap: "lk:y", when: "no pending id", expect: "ack()" },
]);

ledger("unknown namespace and handler errors", [
  { tap: "zz:1", when: "unknown namespace", expect: "ack()" },
  {
    tap: `rt:${ID}`,
    when: "handler throws, the toast is cut to 200 characters",
    setup: (h) => {
      withJot({ status: "failed" })(h);
      h.repo.resetForRetry = () => {
        throw new Error("x".repeat(300));
      };
    },
    expect: `repo.getJot > repo.resetForRetry > ack(⚠️ ${"x".repeat(197)})`,
  },
]);

// --- ti ---

ledger("ti", [
  {
    tap: `ti:y:${ID}`,
    when: "moved, answered after the vault move and the section update",
    setup: (h) => {
      withJot()(h);
      h.obsidian.moveToTil = "moved";
      h.repo.groupFollowers = [jot({ id: "bbbbbbbb" })];
    },
    expect:
      "repo.getJot > obsidian.moveToTil > repo.groupFollowers > repo.updateJot×2 > ack(moved to TIL) > tg.editMessageText",
  },
  {
    tap: `ti:y:${ID}`,
    when: "move fails, alert and the card keeps its buttons",
    setup: (h) => {
      withJot()(h);
      h.obsidian.moveToTil = () => {
        throw new Error("obsidian is down");
      };
    },
    expect:
      "repo.getJot > obsidian.moveToTil > ack!(couldn't move it, tap again to retry)",
  },
  {
    tap: `ti:y:${ID}`,
    when: "line is gone",
    setup: (h) => {
      withJot()(h);
      h.obsidian.moveToTil = "no-line";
    },
    expect:
      "repo.getJot > obsidian.moveToTil > ack(couldn't find the line) > tg.editMessageText",
  },
  {
    tap: `ti:y:${ID}`,
    when: "no TIL heading",
    setup: (h) => {
      withJot()(h);
      h.obsidian.moveToTil = "no-heading";
    },
    expect:
      "repo.getJot > obsidian.moveToTil > ack(no TIL heading) > tg.editMessageText",
  },
  {
    tap: `ti:n:${ID}`,
    when: "keep in the journal",
    setup: withJot(),
    expect: "repo.getJot > ack(kept in the journal) > tg.editMessageText",
  },
  {
    tap: `ti:y:${ID}`,
    when: "jot gone",
    expect: "repo.getJot > ack(gone) > tg.editMessageText",
  },
  {
    tap: `ti:y:${ID}`,
    when: "jot deleted",
    setup: withJot({ status: "deleted" }),
    expect: "repo.getJot > ack(gone) > tg.editMessageText",
  },
]);

// --- rate and fu ---

ledger("rate", [
  {
    tap: "rate:2026-08-15:5",
    when: "recorded, answered after the database and the frontmatter write",
    setup: (h) => {
      h.repo.recordRating = { recorded: true, current: 5 };
    },
    expect:
      "repo.recordRating > obsidian.setDailyRating > ack(saved 5/10) > tg.editMessageText > repo.getSetting > obsidian.readDailyNote > tg.sendMessage",
  },
  {
    tap: "rate:2026-08-15:5",
    when: "day already rated",
    setup: (h) => {
      h.repo.recordRating = { recorded: false, current: 7 };
    },
    expect: "repo.recordRating > ack(already rated 7/10) > tg.editMessageText",
  },
  {
    tap: "rate:2026-08-15:5",
    when: "frontmatter write fails, the error handler answers",
    setup: (h) => {
      h.repo.recordRating = { recorded: true, current: 5 };
      h.obsidian.setDailyRating = () => {
        throw new Error("obsidian is down");
      };
    },
    expect:
      "repo.recordRating > obsidian.setDailyRating > repo.clearRating > ack(⚠️ obsidian is down)",
  },
  {
    tap: "rate:2026-08-15:11",
    when: "rating out of range",
    expect: "ack(bad rating)",
  },
  { tap: "rate:nope:5", when: "bad date", expect: "ack(bad rating)" },
]);

ledger("fu", [
  {
    tap: "fu:j:2026-08-15",
    when: "skip, answered first",
    expect:
      "ack() > tg.deleteMessage > obsidian.readDailyNote > tg.sendMessage",
  },
  {
    tap: "fu:j:2026-08-15",
    when: "second tap on the same prompt",
    setup: async (h) => void (await h.tap("fu:j:2026-08-15")),
    expect: "ack()",
  },
  {
    tap: "fu:j:2026-08-15",
    when: "prompt message gone",
    message: null,
    expect: "ack()",
  },
  {
    tap: "fu:x:2026-08-15",
    when: "unknown question",
    expect: "ack(bad follow-up)",
  },
  {
    tap: "fu:j:not-a-date",
    when: "bad date",
    expect: "ack(bad follow-up)",
  },
]);

// --- hb ---

const HABITS_NOTE = [
  "## Habits",
  "- [ ] Practiced music #meta/habits/music",
  "- [ ] [Pages read:: 0] #meta/habits/reading",
].join("\n");
const withHabits = (h: Harness) => {
  h.obsidian.readDailyNote = { path: "p.md", content: HABITS_NOTE };
  h.obsidian.readNote = HABITS_NOTE;
};

ledger("hb", [
  {
    tap: "hb:2026-08-15:begin",
    when: "begin, answered first",
    setup: withHabits,
    expect: "ack() > obsidian.readDailyNote > tg.editMessageText",
  },
  {
    tap: "hb:2026-08-15:0:y",
    when: "yes, answered after the note write",
    setup: withHabits,
    expect:
      "obsidian.readDailyNote > obsidian.updateNote > obsidian.readNote > obsidian.writeNote > ack() > obsidian.readDailyNote",
  },
  {
    tap: "hb:2026-08-15:0:n",
    when: "no leaves the note alone",
    setup: withHabits,
    expect: "obsidian.readDailyNote > ack() > obsidian.readDailyNote",
  },
  {
    tap: "hb:2026-08-15:0:y",
    when: "note gone",
    expect: "obsidian.readDailyNote > ack(gone)",
  },
  {
    tap: "hb:2026-08-15:7:y",
    when: "habit gone",
    setup: withHabits,
    expect: "obsidian.readDailyNote > ack(gone)",
  },
  { tap: "hb:2026-08-15:x", when: "bad index", expect: "ack(bad habit)" },
  { tap: "hb:nope:begin", when: "bad date", expect: "ack(bad habit)" },
]);

// --- cm ---

const turn = (over: object = {}) => ({
  id: "t1",
  prompt: "p",
  state: "running",
  feed: [],
  chatId: 1,
  ...over,
});
const withConfirmation = (h: Harness) =>
  h.bot.command.pending.set("c1", {
    decide: () => {},
    timer: setTimeout(() => {}, 0),
  });

ledger("cm", [
  {
    tap: "cm:y:c1",
    when: "approve",
    setup: withConfirmation,
    expect: "ack(doing it) > tg.editMessageText",
  },
  {
    tap: "cm:n:c1",
    when: "decline",
    setup: withConfirmation,
    expect: "ack(skipped) > tg.editMessageText",
  },
  { tap: "cm:y:c1", when: "no such confirmation", expect: "ack(expired)" },
  {
    tap: "cm:s:t1",
    when: "stop the running turn",
    setup: (h) => {
      h.bot.command.active = turn();
    },
    expect: "ack(stopping…)",
  },
  {
    tap: "cm:s:t2",
    when: "drop a queued turn",
    setup: (h) => {
      h.bot.command.active = turn();
      h.bot.command.queue = [turn({ id: "t2", state: "queued" })];
    },
    expect: "ack(dropped) > tg.sendMessage",
  },
  {
    tap: "cm:s:t1",
    when: "stop an unknown turn",
    expect: "ack(nothing to stop)",
  },
]);

// --- rp ---

const DONE_JOTS = [jot(), jot({ id: "bbbbbbbb", anchor: "bbbbbbbb" })];
const RESET = "repo.resetForReprocess > queue.add > tg.editMessageText";
const withDayJots = (h: Harness) => {
  h.repo.jotsInRange = DONE_JOTS;
  h.repo.resetForReprocess = ["aaaaaaaa", "bbbbbbbb"];
};

ledger("rp", [
  {
    tap: "rp:go:d:2026-08-15",
    when: "execute day, answered before the lookup and the reset",
    setup: withDayJots,
    expect: `ack() > repo.jotsInRange > ${RESET}`,
  },
  {
    tap: "rp:go:r:2026-08-01:2026-08-03",
    when: "execute range, answered before the lookup and the reset",
    setup: withDayJots,
    expect: `ack() > repo.jotsInRange > ${RESET}`,
  },
  {
    tap: `rp:go:j:${ID}`,
    when: "execute one jot, answered before the lookup and the reset",
    setup: (h) => {
      withJot()(h);
      h.repo.resetForReprocess = [ID];
    },
    expect: `ack() > repo.getJot > ${RESET}`,
  },
  {
    tap: `rp:go:j:${ID}`,
    when: "execute one jot that is gone",
    expect: "ack() > repo.getJot > tg.editMessageText",
  },
  {
    tap: "rp:go:d:nope",
    when: "execute day, bad date",
    expect: "ack(bad date)",
  },
  {
    tap: "rp:go:r:2026-08-01:nope",
    when: "execute range, bad date",
    expect: "ack(bad date)",
  },
  { tap: "rp:go:j", when: "execute one jot, no id", expect: "ack(bad jot id)" },
  { tap: "rp:go:x:1", when: "execute with an unknown mode", expect: "ack()" },
  {
    tap: "rp:root",
    when: "back to the scope picker",
    expect: "ack() > tg.editMessageText",
  },
  { tap: "rp:noop", when: "calendar filler cell", expect: "ack()" },
  {
    tap: "rp:close",
    when: "message deleted",
    expect: "ack() > tg.deleteMessage",
  },
  {
    tap: "rp:cancel",
    when: "message cannot be deleted",
    fail: ["deleteMessage"],
    expect: "ack() > tg.deleteMessage > tg.editMessageText",
  },
  { tap: "rp:bogus", when: "unknown action", expect: "ack()" },
  { tap: "rp:day", when: "day calendar", expect: "ack() > tg.editMessageText" },
  {
    tap: "rp:day:2026:13:40",
    when: "day tap with an impossible date",
    expect: "ack(bad date)",
  },
  {
    tap: "rp:day:2026:8:15",
    when: "day with jots",
    setup: withDayJots,
    expect: "ack() > repo.jotsInRange > tg.editMessageText",
  },
  {
    tap: "rp:day:2026:8:15",
    when: "day with no jots",
    expect: "ack() > repo.jotsInRange > tg.editMessageText",
  },
  {
    tap: "rp:range",
    when: "range start calendar",
    expect: "ack() > tg.editMessageText",
  },
  {
    tap: "rp:range:2026:8:3",
    when: "range start picked",
    expect: "ack() > tg.editMessageText",
  },
  {
    tap: "rp:range:2026:8:99",
    when: "range start with an impossible date",
    expect: "ack(bad date)",
  },
  {
    tap: "rp:rangeend:2026-08-03:2026:8",
    when: "range end calendar",
    expect: "ack() > tg.editMessageText",
  },
  {
    tap: "rp:rangeend:nope:2026:8",
    when: "range end calendar, bad start",
    expect: "ack(bad date)",
  },
  {
    tap: "rp:rangeend:2026-08-03:2026:8:9",
    when: "range end picked",
    setup: withDayJots,
    expect: "ack() > repo.jotsInRange > tg.editMessageText",
  },
  {
    tap: "rp:rangeend:2026-08-03:2026:8:9",
    when: "range with no jots",
    expect: "ack() > repo.jotsInRange > tg.editMessageText",
  },
  {
    tap: "rp:rangeend:2026-08-03:2026:8:99",
    when: "range end with an impossible date",
    expect: "ack(bad date)",
  },
  {
    tap: "rp:jot:0",
    when: "jot page",
    setup: (h) => {
      h.repo.jotsPage = DONE_JOTS;
    },
    expect: "ack() > repo.jotsPage > tg.editMessageText",
  },
  {
    tap: "rp:jot:0",
    when: "no jots at all",
    expect: "ack() > repo.jotsPage > tg.editMessageText",
  },
  {
    tap: `rp:jotpick:${ID}`,
    when: "jot picked",
    setup: withJot(),
    expect: "repo.getJot > ack() > tg.editMessageText",
  },
  {
    tap: `rp:jotpick:${ID}`,
    when: "jot gone",
    expect: "repo.getJot > ack(gone)",
  },
  {
    tap: `rp:jotpick:${ID}`,
    when: "jot still processing",
    setup: withJot({ status: "processing" }),
    expect: "repo.getJot > ack(not reprocessable anymore)",
  },
]);

// --- tk ---

const TASK_NOTE = [
  "## Things to do",
  "- [ ] Buy cat sand #type/todo [start:: 2026-08-28] [due:: 2026-09-02]",
].join("\n");
const TASK_FINGERPRINT = parseTasks(
  TASK_NOTE,
  "Things to do",
  "#type/todo",
  "personal",
)[0]!.fingerprint;

const draft = (over: Partial<TaskDraftRow> = {}): TaskDraftRow => ({
  id: "d1d1d1d1",
  source: "mode",
  jot_id: null,
  type: "personal",
  description: "Buy cat sand",
  start: null,
  due: "2026-09-02",
  source_date: "2026-08-16",
  status: "pending",
  chat_id: 1,
  message_id: 50,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});
const withDraft =
  (over: Partial<TaskDraftRow> = {}) =>
  (h: Harness) => {
    h.repo.getTaskDraft = draft(over);
  };
const withTaskNote = (h: Harness) => {
  h.obsidian.readNote = TASK_NOTE;
};

ledger("tk", [
  {
    tap: "tk:ok:d1d1d1d1",
    when: "create, answered after the claim and before the note write",
    setup: (h) => {
      withDraft()(h);
      withTaskNote(h);
      h.repo.claimTaskDraft = true;
    },
    expect:
      "repo.getTaskDraft > repo.claimTaskDraft > ack(creating…) > obsidian.updateNote > obsidian.readNote > obsidian.writeNote > tg.editMessageText",
  },
  {
    tap: "tk:ok:d1d1d1d1",
    when: "create loses the claim",
    setup: (h) => {
      withDraft()(h);
      h.repo.claimTaskDraft = false;
    },
    expect: "repo.getTaskDraft > repo.claimTaskDraft > ack(already created)",
  },
  {
    tap: "tk:ok:d1d1d1d1",
    when: "create without a due date",
    setup: withDraft({ due: null }),
    expect:
      "repo.getTaskDraft > ack(it needs a due date first) > tg.sendMessage",
  },
  {
    tap: "tk:d:d1d1d1d1",
    when: "change the description",
    setup: withDraft(),
    expect:
      "repo.getTaskDraft > ack(Answer the prompt below ↓) > tg.sendMessage",
  },
  {
    tap: "tk:t:d1d1d1d1",
    when: "toggle the type",
    setup: withDraft(),
    expect:
      "repo.getTaskDraft > ack(🏢 Work) > repo.updateTaskDraft > tg.editMessageText",
  },
  {
    tap: "tk:x:d1d1d1d1",
    when: "cancel a typed task",
    setup: withDraft(),
    expect:
      "repo.getTaskDraft > ack(dropped) > repo.updateTaskDraft > tg.editMessageText",
  },
  {
    tap: "tk:x:d1d1d1d1",
    when: "dismiss a suggestion",
    setup: withDraft({ source: "jot" }),
    expect:
      "repo.getTaskDraft > ack(not a task) > repo.updateTaskDraft > tg.editMessageText",
  },
  {
    tap: "tk:t:d1d1d1d1",
    when: "draft unknown",
    expect: "repo.getTaskDraft > ack(expired)",
  },
  {
    tap: "tk:t:d1d1d1d1",
    when: "draft already settled",
    setup: withDraft({ status: "created" }),
    expect: "repo.getTaskDraft > ack(already created)",
  },
  {
    tap: `tk:k:personal:0:${TASK_FINGERPRINT}:open:0`,
    when: "tick, answered before the note write",
    setup: withTaskNote,
    expect:
      "ack(ticking…) > obsidian.updateNote > obsidian.readNote > obsidian.writeNote > obsidian.readNote×2 > tg.editMessageText",
  },
  {
    tap: `tk:r:personal:0:${TASK_FINGERPRINT}:done:0`,
    when: "reopen after the note changed",
    setup: (h) => {
      h.obsidian.readNote = "## Things to do\n";
    },
    expect:
      "ack(reopening…) > obsidian.updateNote > obsidian.readNote > tg.sendMessage > obsidian.readNote×2 > tg.editMessageText",
  },
  {
    tap: "tk:k:personal:0",
    when: "tick without a fingerprint",
    expect: "ack(expired)",
  },
  {
    tap: "tk:m",
    when: "task menu",
    expect: "ack() > repo.getSetting×2 > tg.editMessageText",
  },
  {
    tap: "tk:v:open:0",
    when: "open list",
    setup: withTaskNote,
    expect: "ack() > obsidian.readNote×2 > tg.editMessageText",
  },
  {
    tap: "tk:v:open:0",
    when: "notes cannot be read",
    setup: (h) => {
      h.obsidian.readNote = () => {
        throw new Error("obsidian is down");
      };
    },
    expect: "ack() > obsidian.readNote > tg.editMessageText",
  },
  {
    tap: "tk:det",
    when: "toggle task detection, answered after the write",
    expect:
      "repo.toggleSetting > ack(I'll stop suggesting tasks) > repo.getSetting×2 > tg.editMessageText",
  },
  {
    tap: "tk:til",
    when: "toggle TIL detection, answered after the write",
    expect:
      "repo.toggleSetting > ack(I'll stop suggesting TILs) > repo.getSetting×2 > tg.editMessageText",
  },
  {
    tap: "tk:close",
    when: "message deleted",
    expect: "ack() > tg.deleteMessage",
  },
  {
    tap: "tk:close",
    when: "message cannot be deleted",
    fail: ["deleteMessage"],
    expect: "ack() > tg.deleteMessage > tg.editMessageText",
  },
  { tap: "tk:bogus", when: "unknown action", expect: "ack()" },
]);

// --- menu ---

const STOPWORDS = ["the", "and"];
const PAIRS = [{ surface: "milk", note: "Milk" }];
/** Opens the pair flow the way the owner does: by answering the words prompt. */
const withFlow = async (h: Harness, words = ["milk"]) => {
  h.links.entries = [{ note: "Milk", alias: "milk" }];
  await h.say(words.join(", "), { message_id: 7, text: "(lw:rg)" });
};

ledger("menu: jot actions", [
  {
    tap: `menu:jdy:${ID}`,
    when: "delete, answered before the vault write",
    setup: withJot(),
    expect: `repo.getJot > ack() > obsidian.updateNote > obsidian.readNote > obsidian.writeNote > repo.markDeleted > repo.groupFollowers > tg.editMessageText`,
  },
  {
    tap: `menu:jdy:${ID}`,
    when: "delete, jot gone",
    expect: "repo.getJot > ack(gone)",
  },
  {
    tap: `menu:jr:${ID}`,
    when: "retry, answered after the reset and the queue",
    setup: withJot({ status: "failed" }),
    expect:
      "repo.getJot > repo.resetForRetry > queue.add > ack(retrying) > tg.editMessageText",
  },
  {
    tap: `menu:jr:${ID}`,
    when: "retry, jot gone",
    expect: "repo.getJot > ack(gone)",
  },
  {
    tap: `menu:jd:${ID}`,
    when: "delete confirmation",
    expect: "ack() > tg.editMessageText",
  },
  {
    tap: "menu:jd",
    when: "delete confirmation without an id",
    expect: "ack()",
  },
  {
    tap: `menu:je:${ID}`,
    when: "edit prompt",
    setup: withJot(),
    expect: "repo.getJot > ack() > tg.sendMessage > repo.mapMessage",
  },
  {
    tap: `menu:je:${ID}`,
    when: "edit, jot gone",
    expect: "repo.getJot > ack(gone)",
  },
]);

ledger("menu: screens", [
  {
    tap: "menu:root",
    when: "root",
    expect: "ack() > repo.getSetting×6 > repo.ratingTime > tg.editMessageText",
  },
  {
    tap: "menu:maint",
    when: "maintenance",
    expect: "ack() > tg.editMessageText",
  },
  { tap: "menu:zz", when: "unknown action", expect: "ack()" },
  {
    tap: "menu:close",
    when: "message deleted",
    expect: "ack() > tg.deleteMessage",
  },
  {
    tap: "menu:close",
    when: "message cannot be deleted",
    fail: ["deleteMessage"],
    expect: "ack() > tg.deleteMessage > tg.editMessageText",
  },
  {
    tap: "menu:jots",
    when: "no jots",
    expect: "ack() > repo.recentJots > tg.editMessageText",
  },
  {
    tap: "menu:jots",
    when: "recent jots",
    setup: (h) => {
      h.repo.recentJots = DONE_JOTS;
    },
    expect: "ack() > repo.recentJots > tg.editMessageText",
  },
  {
    tap: `menu:jot:${ID}`,
    when: "jot detail",
    setup: withJot(),
    expect: "ack() > repo.getJot > tg.editMessageText",
  },
  {
    tap: `menu:jot:${ID}`,
    when: "jot gone",
    expect: "ack() > repo.getJot > tg.editMessageText",
  },
  {
    tap: "menu:failed",
    when: "nothing failed",
    expect: "ack() > repo.failedJots > tg.editMessageText",
  },
  {
    tap: "menu:failed",
    when: "failed jots",
    setup: (h) => {
      h.repo.failedJots = [jot({ status: "failed", error: "boom" })];
    },
    expect: "ack() > repo.failedJots > tg.editMessageText",
  },
  {
    tap: "menu:stats",
    when: "range picker",
    expect: "ack() > tg.editMessageText",
  },
  {
    tap: "menu:stats:today",
    when: "range picked",
    expect: "ack() > repo.windowStats > tg.editMessageText",
  },
  {
    tap: "menu:status",
    when: "status",
    expect: "ack() > repo.statusCounts > tg.editMessageText",
  },
  {
    tap: "menu:esz",
    when: "entry size screen",
    expect: "ack() > repo.getSetting > tg.editMessageText",
  },
  {
    tap: "menu:em",
    when: "enrichment model picker",
    expect: "ack() > repo.getSetting > tg.editMessageText",
  },
  {
    tap: "menu:vfm",
    when: "voice fix model picker",
    expect: "ack() > repo.getSetting > tg.editMessageText",
  },
]);

ledger("menu: entry points into other flows", [
  {
    tap: "menu:rate",
    when: "rating prompt",
    expect: "ack(Opening rating prompt below ↓) > tg.sendMessage",
  },
  {
    tap: "menu:habits",
    when: "habits review",
    expect: "ack(Opening habits review below ↓) > obsidian.readDailyNote",
  },
  {
    tap: "menu:tasks",
    when: "task menu",
    expect: "ack(Opening tasks below ↓) > repo.getSetting×2 > tg.sendMessage",
  },
  { tap: "menu:taskmode", when: "task mode", expect: "ack() > tg.sendMessage" },
  {
    tap: "menu:reprocess",
    when: "reprocess menu",
    expect: "ack(Opening reprocess menu below ↓) > tg.sendMessage",
  },
]);

ledger("menu: maintenance", [
  {
    tap: "menu:flush",
    when: "flush",
    expect: "ack() > queue.flush > tg.editMessageText",
  },
  {
    tap: "menu:sweep",
    when: "/sweep command",
    expect: "ack() > processor.retryPass > tg.editMessageText",
  },
  {
    tap: "menu:unstick",
    when: "unstick",
    expect: "ack() > repo.resetProcessing > tg.editMessageText",
  },
  {
    tap: "menu:retryall",
    when: "retry all confirmation",
    expect: "ack() > tg.editMessageText",
  },
  {
    tap: "menu:retryally",
    when: "retry all",
    expect: "ack() > repo.resetFailed > tg.editMessageText",
  },
]);

ledger("menu: settings", [
  {
    tap: "menu:vfix",
    when: "voice fix toggle, answered after the write",
    expect:
      "repo.toggleSetting > ack(Voice fix on) > repo.getSetting×6 > repo.ratingTime > tg.editMessageText",
  },
  {
    tap: "menu:rtsw",
    when: "nightly rating toggle, answered after the write",
    expect:
      "repo.toggleSetting > ack(Nightly rating off) > repo.getSetting×6 > repo.ratingTime > tg.editMessageText",
  },
  {
    tap: "menu:fusw",
    when: "follow-up toggle, answered after the write",
    expect:
      "repo.toggleSetting > ack(Follow-up off) > repo.getSetting×6 > repo.ratingTime > tg.editMessageText",
  },
  {
    tap: "menu:rtsw",
    when: "toggle with the answer and the redraw both rejected",
    fail: ["answerCallbackQuery", "editMessageText"],
    expect:
      "repo.toggleSetting > ack(Nightly rating off) > repo.getSetting×6 > repo.ratingTime > tg.editMessageText",
  },
  {
    tap: "menu:vfix",
    when: "voice fix toggle with the answer and the redraw both rejected",
    fail: ["answerCallbackQuery", "editMessageText"],
    expect:
      "repo.toggleSetting > ack(Voice fix on) > repo.getSetting×6 > repo.ratingTime > tg.editMessageText",
  },
  {
    tap: "menu:rtt",
    when: "rating time prompt",
    expect: "ack(Answer the prompt below ↓) > tg.sendMessage",
  },
  {
    tap: "menu:ems:claude-sonnet-5",
    when: "enrichment model chosen, answered after the write",
    expect:
      "repo.setSetting > enricher.setModel > ack(enrichment: sonnet 5) > repo.getSetting > tg.editMessageText",
  },
  {
    tap: "menu:vfs:claude-haiku-4-5",
    when: "voice fix model chosen, answered after the write",
    expect:
      "repo.setSetting > ack(voice fix: haiku 4.5) > repo.getSetting > tg.editMessageText",
  },
  {
    tap: "menu:ems",
    when: "enrichment model without a name",
    expect: "ack(expired)",
  },
  {
    tap: "menu:emc",
    when: "custom enrichment model prompt",
    expect: "ack(Answer the prompt below ↓) > tg.sendMessage",
  },
  {
    tap: "menu:vfc",
    when: "custom voice fix model prompt",
    expect: "ack(Answer the prompt below ↓) > tg.sendMessage",
  },
  {
    tap: "menu:ess:280",
    when: "entry size chosen, answered before the write",
    expect:
      "ack(280 chars) > repo.setSetting > repo.getSetting > tg.editMessageText",
  },
  {
    tap: "menu:ess:0",
    when: "splitting turned off, answered before the write",
    expect:
      "ack(splitting off) > repo.setSetting > repo.getSetting > tg.editMessageText",
  },
  {
    tap: "menu:ess",
    when: "entry size without a value",
    expect: "ack(expired)",
  },
  {
    tap: "menu:ess:abc",
    when: "entry size not a number",
    expect: "ack(expired)",
  },
  {
    tap: "menu:esc",
    when: "custom entry size prompt",
    expect: "ack(Answer the prompt below ↓) > tg.sendMessage",
  },
]);

ledger("menu: link rules", [
  {
    tap: "menu:lswd:0",
    when: "remove a word, answered before the write",
    setup: (h) => {
      h.repo.stopwordList = STOPWORDS;
    },
    expect:
      "repo.stopwordList > ack() > repo.delStopword > repo.stopwordList > tg.editMessageText",
  },
  {
    tap: "menu:lswd:0",
    when: "remove a word that is gone",
    expect: "repo.stopwordList > ack(expired)",
  },
  {
    tap: "menu:lrju:0:0",
    when: "undo a rejection, answered before the write",
    setup: (h) => {
      h.repo.rejectionList = PAIRS;
      h.repo.unreject = 1;
    },
    expect:
      "repo.rejectionList > ack() > repo.unreject > repo.rejectionList×2 > tg.editMessageText",
  },
  {
    tap: "menu:lrju:0:0",
    when: "undo a rejection that is gone",
    expect: "repo.rejectionList > ack(expired)",
  },
  {
    tap: "menu:lrgd:0",
    when: "delete a pair, answered before the write",
    setup: (h) => {
      h.repo.registeredLinks = PAIRS;
    },
    expect:
      "repo.registeredLinks > ack(dropped milk) > repo.delRegisteredLink > repo.registeredLinks > tg.editMessageText",
  },
  {
    tap: "menu:lrgd:0",
    when: "delete a pair that is gone",
    expect: "repo.registeredLinks > ack(expired)",
  },
  {
    tap: "menu:lrgp:0",
    when: "pick a note, answered before the write",
    setup: (h) => withFlow(h),
    expect:
      "ack(milk → Milk) > repo.addRegisteredLink > repo.registeredLinks > tg.editMessageText",
  },
  {
    tap: "menu:lrgp:5",
    when: "pick a suggestion that is not there",
    setup: (h) => withFlow(h),
    expect: "ack(expired)",
  },
  { tap: "menu:lrgp:0", when: "pick without a flow", expect: "ack(expired)" },
  {
    tap: "menu:lrgs",
    when: "skip a word",
    setup: (h) => withFlow(h, ["milk", "bread"]),
    expect: "ack(skipped) > tg.editMessageText",
  },
  {
    tap: "menu:lrgc",
    when: "cancel the flow",
    setup: (h) => withFlow(h),
    expect: "ack(cancelled) > repo.registeredLinks > tg.editMessageText",
  },
  {
    tap: "menu:lrgt:0",
    when: "change the note of a pair",
    setup: (h) => {
      h.repo.registeredLinks = PAIRS;
      h.links.entries = [{ note: "Milk", alias: "milk" }];
    },
    expect: "repo.registeredLinks > ack() > tg.editMessageText",
  },
  {
    tap: "menu:lrgt:0",
    when: "change the note of a pair that is gone",
    expect: "repo.registeredLinks > ack(expired)",
  },
  {
    tap: "menu:lrgn:0",
    when: "note picker page",
    setup: (h) => withFlow(h),
    expect: "ack() > tg.editMessageText",
  },
  {
    tap: "menu:lrgn:0",
    when: "note picker page without a flow",
    expect: "ack() > tg.sendMessage",
  },
  {
    tap: "menu:links",
    when: "step 1",
    expect:
      "ack() > repo.stopwordList > repo.rejectionList > repo.registeredLinks > tg.editMessageText",
  },
  {
    tap: "menu:lsw",
    when: "never-link step",
    expect: "ack() > repo.stopwordList > tg.editMessageText",
  },
  {
    tap: "menu:lswl:0",
    when: "never-link page",
    expect: "ack() > repo.stopwordList > tg.editMessageText",
  },
  {
    tap: "menu:lrj:0",
    when: "rejected words",
    expect: "ack() > repo.rejectionList > tg.editMessageText",
  },
  {
    tap: "menu:lrjs:0",
    when: "rejected notes of a word",
    setup: (h) => {
      h.repo.rejectionList = PAIRS;
    },
    expect: "ack() > repo.rejectionList > tg.editMessageText",
  },
  {
    tap: "menu:lrg",
    when: "always-link pairs",
    expect: "ack() > repo.registeredLinks > tg.editMessageText",
  },
  {
    tap: "menu:lrgv:0",
    when: "pair detail",
    setup: (h) => {
      h.repo.registeredLinks = PAIRS;
    },
    expect: "ack() > repo.registeredLinks > tg.editMessageText",
  },
  {
    tap: "menu:lrgv:0",
    when: "pair detail, pair gone",
    expect: "ack() > repo.registeredLinks×2 > tg.editMessageText",
  },
  {
    tap: "menu:lswa",
    when: "add a never-link word prompt",
    expect: "ack(Answer the prompt below ↓) > tg.sendMessage",
  },
  {
    tap: "menu:lrga",
    when: "add pairs prompt",
    expect: "ack(Answer the prompt below ↓) > tg.sendMessage",
  },
  {
    tap: "menu:lrgw:0",
    when: "rename prompt",
    expect: "ack(Answer the prompt below ↓) > tg.sendMessage",
  },
  {
    tap: "menu:lrgq",
    when: "search prompt",
    expect: "ack(Answer the prompt below ↓) > tg.sendMessage",
  },
  {
    tap: "menu:lrgm",
    when: "type a note prompt",
    expect: "ack(Answer the prompt below ↓) > tg.sendMessage",
  },
]);
