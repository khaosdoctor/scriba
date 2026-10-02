import type { Repository } from "../data/repositories/index.ts";
import type { TaskNotesService } from "../data/repositories/task-notes.ts";
import type { SwitchKey } from "../domain/setting/entity.ts";
import type {
  TaskDraft,
  TaskDraftRow,
  TaskType,
} from "../domain/task/entity.ts";
import { makeJotId } from "../libs/jot.ts";
import { logger } from "../libs/log.ts";
import { paginate } from "../libs/page.ts";
import {
  draftFromDetection,
  filterTasks,
  parseTaskDate,
  parseTaskDraft,
  type TaskView,
  TYPE_LABEL,
  taskButtonLabel,
  taskCard,
  taskListLine,
  VIEW_LABEL,
} from "../libs/tasks.ts";
import { escapeHtml, fitTelegram } from "../libs/text.ts";
import { plainDate } from "../libs/time.ts";
import type { Enricher } from "./enrich.ts";
import type { Modes, OpenOutcome } from "./modes.ts";
import type { Notifier } from "./notifier.ts";
import type { VoiceService } from "./voice.ts";

const log = logger("tasks-flow");

export const TASKS_NS = "tk";

/** Marker of `/taskadd`'s "what's the task?" prompt: there is no draft id yet. */
export const TASK_ADD_REF = "(tk:add)";

export type TaskField = "d" | "s" | "u";
export type TaskRef = { field: "add" } | { field: TaskField; id: string };
export type AnswerOutcome =
  | "ok"
  | "settled"
  | "noText"
  | "noTask"
  | "nothing"
  | "badDate"
  | "needsDue";
export type ClaimOutcome = "claimed" | "noDue" | "lost";

type Row = [text: string, callbackData: string][];
export type Keyboard = {
  inline_keyboard: { text: string; callback_data: string }[][];
};
export type Screen = { text: string; keyboard: Keyboard };

export interface TaskDeps {
  repo: Repository;
  notes: TaskNotesService;
  enricher: Enricher;
  notifier: Pick<Notifier, "notify" | "send" | "edit" | "delete">;
  modes: Modes;
  ownerId: number;
  voice: Pick<VoiceService, "transcribe">;
}

const PAGE = 8;

/** Lists don't self-destruct the way /menu's screens do, so Close is how they go. */
const CLOSE: Row[number] = ["✖ Close", `${TASKS_NS}:close`];

const MENU_TEXT =
  "🗂 Tasks\n\nTap a list to see it. Tapping a task in an open list ticks it off; the done list reopens one.";

const PROMPTS: Record<TaskField, string> = {
  d: "✏️ Reply to this message with what the task should say.",
  s: "📅 Reply to this message with the start date — a date, “next monday”, or “none” to leave it to the deadline.",
  u: "🏁 Reply to this message with the due date — a date, or something like “next friday”. This one it needs.",
};

const keyboard = (rows: Row[]): Keyboard => ({
  inline_keyboard: rows.map((row) =>
    row.map(([text, callback_data]) => ({ text, callback_data })),
  ),
});

const cardKeyboard = (row: TaskDraftRow) => {
  const at = (action: string) => `${TASKS_NS}:${action}:${row.id}`;
  return keyboard([
    [
      ["✏️ Description", at("d")],
      [`🔁 ${TYPE_LABEL[row.type]}`, at("t")],
    ],
    [
      [`📅 Start: ${row.start ?? row.due ?? "—"}`, at("s")],
      [`🏁 Due: ${row.due ?? "needed"}`, at("u")],
    ],
    [
      ["✅ Create", at("ok")],
      [row.source === "jot" ? "🚫 Not a task" : "✖️ Cancel", at("x")],
    ],
  ]);
};

const cardText = (row: TaskDraftRow) =>
  taskCard(
    row,
    row.source === "jot" ? "📝 That sounds like a task" : "📝 New task",
  );

function patchFor(
  field: TaskField,
  body: string,
  draft: string,
): Partial<TaskDraftRow> | "noText" | "badDate" | "needsDue" {
  if (field === "d") return body ? { description: body } : "noText";
  const date = parseTaskDate(body, plainDate());
  if (date === undefined) {
    log.warn({ draft, body }, "task: unreadable date reply");
    return "badDate";
  }
  if (field === "u" && date === null) {
    log.warn({ draft }, "task: refused to clear the deadline");
    return "needsDue";
  }
  return field === "s" ? { start: date } : { due: date };
}

/** Nothing is written straight from a message: it becomes a draft on a card and only Create
 *  writes the note. Drafts live in the DB because a description can't ride in Telegram's 64
 *  bytes of callback data. Created tasks are not tracked, the task notes stay the source of
 *  truth. */
export class TaskService {
  /** Prompt message id -> its draft. A question is scaffolding: once answered, or once the
   *  card settles, it leaves the chat. In memory: a restart forgets at most one prompt. */
  private prompts = new Map<number, string>();

  constructor(private deps: TaskDeps) {}

  isOpen(): boolean {
    return this.deps.modes.isOpen("task");
  }

  start(): OpenOutcome {
    const outcome = this.deps.modes.open("task");
    if (outcome === "busy")
      log.warn("task mode refused — command mode is open");
    return outcome;
  }

  /** One message in task mode, parsed token-free. False when it holds no task. */
  async handle(text: string): Promise<boolean> {
    this.deps.modes.touch();
    const draft = parseTaskDraft(text, plainDate());
    log.info(
      {
        chars: text.length,
        type: draft.type,
        start: draft.start,
        due: draft.due,
      },
      "task mode: message parsed",
    );
    return this.propose(
      draft,
      text,
      "task mode: nothing to do in that message",
    );
  }

  /** The transcript of a voice note sent while task mode is open. The view owns the
   *  Telegram side; the layer rule keeps the voice service behind the controller. */
  spokenTask(fileId: string): Promise<string> {
    return this.deps.voice.transcribe(fileId);
  }

  /** `/taskadd`: the enricher reads the line, its timing is resolved by chrono against today,
   *  and a failed call falls back to the token-free parser (a rougher split beats no task).
   *  False when the line holds no task. */
  async quickAdd(text: string): Promise<boolean> {
    const today = plainDate();
    let draft: TaskDraft;
    try {
      draft = draftFromDetection(
        await this.deps.enricher.extractTask(text),
        today,
      );
      log.info(
        {
          chars: text.length,
          due: draft.due,
          start: draft.start,
          type: draft.type,
        },
        "/taskadd: read by the enricher",
      );
    } catch (err) {
      draft = parseTaskDraft(text, today);
      log.warn(
        { err, due: draft.due },
        "/taskadd: enricher unavailable — fell back to the token-free parser",
      );
    }
    return this.propose(
      draft,
      text,
      "/taskadd: nothing to do in that line",
      true,
    );
  }

  /** A task found in a journal entry, on the same card plus a way to say it wasn't one. */
  async suggest(
    draft: TaskDraft,
    jotId: string,
    jotDate: string,
  ): Promise<void> {
    const row = await this.save(draft, jotDate, jotId);
    log.info(
      { draft: row.id, jotId, due: row.due },
      "task suggested from a jot",
    );
    await this.sendCard(row);
    if (!row.due) await this.ask(row, "u");
  }

  /** A card for a parsed draft. A task needs a deadline, so `askDue` asks for a missing one
   *  straight away. */
  private async propose(
    draft: TaskDraft,
    text: string,
    nothing: string,
    askDue = false,
  ): Promise<boolean> {
    if (!draft.description.trim()) {
      log.warn({ text }, nothing);
      return false;
    }
    const row = await this.save(draft, plainDate());
    await this.sendCard(row);
    if (askDue && !row.due) await this.ask(row, "u");
    return true;
  }

  private async save(
    draft: TaskDraft,
    sourceDate: string,
    jotId: string | null = null,
  ): Promise<TaskDraftRow> {
    const now = Date.now();
    const row: TaskDraftRow = {
      ...draft,
      id: makeJotId(),
      source: jotId ? "jot" : "mode",
      jot_id: jotId,
      description: draft.description.trim(),
      source_date: sourceDate,
      status: "pending",
      chat_id: this.deps.ownerId,
      message_id: null,
      created_at: now,
      updated_at: now,
    };
    await this.deps.repo.insertTaskDraft(row);
    return row;
  }

  private async sendCard(row: TaskDraftRow): Promise<void> {
    const id = await this.deps.notifier
      .send(cardText(row), { html: true, keyboard: cardKeyboard(row) })
      .catch((err) => {
        log.error({ err, draft: row.id }, "task card failed to send");
        return null;
      });
    if (id) await this.deps.repo.updateTaskDraft(row.id, { message_id: id });
  }

  private async redraw(row: TaskDraftRow): Promise<void> {
    if (!row.message_id) return this.sendCard(row);
    await this.deps.notifier
      .edit(row.message_id, cardText(row), {
        html: true,
        keyboard: cardKeyboard(row),
      })
      .catch((err) =>
        log.warn({ err, draft: row.id }, "task card redraw failed"),
      );
  }

  /** Final word on a card: no buttons, so a settled task can't be settled twice. */
  private async settle(row: TaskDraftRow, html: string): Promise<void> {
    const { notifier } = this.deps;
    const text = fitTelegram(html);
    if (!row.message_id)
      return void (await notifier.send(text, { html: true }).catch(() => {}));
    await notifier
      .edit(row.message_id, text, {
        html: true,
        keyboard: { inline_keyboard: [] },
      })
      .catch((err) =>
        log.warn({ err, draft: row.id }, "task card settle failed"),
      );
  }

  /** The pending draft a tap refers to, or the toast to answer with once it is gone or
   *  settled. */
  async live(id?: string): Promise<TaskDraftRow | string> {
    const row = id ? await this.deps.repo.getTaskDraft(id) : undefined;
    if (!row) {
      log.warn({ draft: id }, "tasks: tap for an unknown draft");
      return "expired";
    }
    if (row.status !== "pending") {
      log.warn(
        { draft: id, status: row.status },
        "tasks: draft already settled",
      );
      return `already ${row.status}`;
    }
    return row;
  }

  async setType(row: TaskDraftRow, type: TaskType): Promise<void> {
    await this.deps.repo.updateTaskDraft(row.id, { type });
    log.info({ draft: row.id, type }, "task: type toggled");
    await this.redraw({ ...row, type });
  }

  /** Claim the draft before anything is written: two fast taps both see a pending one, and
   *  only the winner of the compare-and-swap may put a line in the note. */
  async claim(row: TaskDraftRow): Promise<ClaimOutcome> {
    if (!row.due) {
      log.warn({ draft: row.id }, "task: create refused — no deadline");
      return "noDue";
    }
    if (!(await this.deps.repo.claimTaskDraft(row.id))) {
      log.warn({ draft: row.id }, "task: create lost the claim");
      return "lost";
    }
    return "claimed";
  }

  /** Write a claimed draft. A failed write hands it back so Create can be tried again. */
  async create(row: TaskDraftRow): Promise<void> {
    try {
      const line = await this.deps.notes.add(row, row.source_date);
      log.info(
        { draft: row.id, type: row.type, due: row.due },
        "task created from a card",
      );
      await this.clearPrompts(row.id);
      await this.settle(
        row,
        `✅ Added to ${TYPE_LABEL[row.type]}\n<blockquote>${escapeHtml(line)}</blockquote>`,
      );
    } catch (err) {
      log.error({ err, draft: row.id }, "task creation failed");
      await this.deps.repo.updateTaskDraft(row.id, { status: "pending" });
      await this.redraw(row);
      const why = err instanceof Error ? err.message : String(err);
      await this.deps.notifier
        .notify(`⚠️ Couldn't write that task: ${why}`)
        .catch(() => {});
    }
  }

  async drop(row: TaskDraftRow): Promise<void> {
    const dismissed = row.source === "jot";
    await this.deps.repo.updateTaskDraft(row.id, {
      status: dismissed ? "dismissed" : "cancelled",
    });
    log.info({ draft: row.id, source: row.source }, "task draft dropped");
    await this.clearPrompts(row.id);
    await this.settle(
      row,
      `${dismissed ? "🚫 Not a task — left it in the journal." : "✖️ Dropped."}\n<blockquote>${escapeHtml(row.description)}</blockquote>`,
    );
  }

  /** Ask for one field; the marker routes the reply back. Only a question that is the direct
   *  result of a button press gets a force_reply, since you can't have been halfway through
   *  typing something else. An unasked one (a suggestion, a `/taskadd` with no timing) never
   *  does: that is how a message meant for the journal gets sent as a date. */
  async ask(
    row: TaskDraftRow,
    field: TaskField,
    fromTap = false,
  ): Promise<void> {
    log.info({ draft: row.id, field }, "task: prompting for a field");
    const id = await this.deps.notifier
      .send(
        `${PROMPTS[field]} (tk:${field}:${row.id})`,
        fromTap ? { forceReply: true } : undefined,
      )
      .catch((err) => {
        log.warn({ err, draft: row.id, field }, "task: prompt failed to send");
        return null;
      });
    if (id) this.prompts.set(id, row.id);
  }

  /** Best-effort: a message older than 48 hours, or already gone, can't be deleted. */
  private async dropPrompt(messageId: number, draft: string): Promise<void> {
    this.prompts.delete(messageId);
    await this.deps.notifier
      .delete(messageId)
      .catch((err) =>
        log.debug({ err, draft, messageId }, "task: prompt already gone"),
      );
  }

  private async clearPrompts(draft: string): Promise<void> {
    for (const [id, owner] of this.prompts)
      if (owner === draft) await this.dropPrompt(id, draft);
  }

  /** The reply to a prompt. A prompt leaves the chat only once its answer is taken: one that
   *  couldn't be read has to stay, or there'd be nothing left to reply to. */
  async answer(
    ref: TaskRef,
    body: string,
    prompt: number,
  ): Promise<AnswerOutcome> {
    if (ref.field === "add") {
      if (!body) return "noTask";
      await this.deps.notifier.delete(prompt).catch(() => {});
      return (await this.quickAdd(body)) ? "ok" : "nothing";
    }
    const row = await this.deps.repo.getTaskDraft(ref.id);
    if (row?.status !== "pending") {
      log.warn(
        { draft: ref.id, status: row?.status },
        "task reply: draft gone",
      );
      return "settled";
    }
    const patch = patchFor(ref.field, body, row.id);
    if (typeof patch === "string") return patch;
    await this.deps.repo.updateTaskDraft(row.id, patch);
    if (ref.field === "d")
      log.info({ draft: row.id }, "task: description changed");
    if (ref.field !== "d")
      log.info(
        {
          draft: row.id,
          field: ref.field,
          date: ref.field === "s" ? patch.start : patch.due,
        },
        "task: date changed",
      );
    await this.dropPrompt(prompt, row.id);
    await this.redraw({ ...row, ...patch });
    return "ok";
  }

  /** One list screen. Each row carries the digest of the line it was drawn from, so a tap
   *  that arrives after the note changed is refused rather than acting on whatever has since
   *  moved into that position. Rejects when the notes can't be read. */
  async list(
    view: TaskView,
    page: number,
    header?: string,
  ): Promise<Screen & { count: number }> {
    const today = plainDate();
    const tasks = filterTasks(await this.deps.notes.list(), view, today);
    const shown = paginate(tasks, page, PAGE);
    log.info(
      {
        view,
        page: shown.page,
        shown: shown.items.length,
        total: tasks.length,
      },
      "tasks: list rendered",
    );
    const to = (p: number) => `${TASKS_NS}:v:${view}:${p}`;
    const nav: Row = [];
    if (shown.page > 0) nav.push(["‹ Prev", to(shown.page - 1)]);
    if (shown.page < shown.pages - 1) nav.push(["Next ›", to(shown.page + 1)]);
    const n = tasks.length;
    const summary = n
      ? `${n} task${n === 1 ? "" : "s"}${shown.pages > 1 ? ` · page ${shown.page + 1}/${shown.pages}` : ""} · tap one to ${view === "done" ? "reopen it" : "tick it off"}`
      : "Nothing here.";
    const lines = shown.items.map((t, i) =>
      taskListLine(t, shown.offset + i + 1, today),
    );
    return {
      text: fitTelegram(
        [header ?? `<b>${VIEW_LABEL[view]}</b>`, summary, "", ...lines].join(
          "\n",
        ),
      ),
      keyboard: keyboard([
        ...shown.items.map(
          (t, i): Row => [
            [
              taskButtonLabel(t, shown.offset + i + 1),
              `${TASKS_NS}:${t.state === "done" ? "r" : "k"}:${t.type}:${t.index}:${t.fingerprint}:${view}:${shown.page}`,
            ],
          ],
        ),
        ...(nav.length ? [nav] : []),
        [["‹ Tasks", `${TASKS_NS}:m`]],
        [CLOSE],
      ]),
      count: n,
    };
  }

  /** Tick or reopen the task a list row points at. When the note moved since the list was
   *  drawn nothing is written and the owner is told. */
  async tick(
    type: TaskType,
    index: number,
    fingerprint: string,
    done: boolean,
  ): Promise<void> {
    const task = await this.deps.notes
      .setDone(type, index, fingerprint, done)
      .catch((err) => {
        log.error({ err, type, index }, "tasks: could not change that task");
        return null;
      });
    if (!task)
      return void (await this.deps.notifier
        .notify(
          "⚠️ That task moved or changed in Obsidian since this list was drawn — here it is again.",
        )
        .catch(() => {}));
    log.info(
      { type, index, done, text: task.text },
      done ? "task ticked from a list" : "task reopened from a list",
    );
  }

  async menu(): Promise<Screen> {
    const { repo } = this.deps;
    const tasks = await repo.getSetting("taskDetection");
    const til = await repo.getSetting("tilDetection");
    const screens = Object.keys(VIEW_LABEL).filter((v) => v !== "future");
    return {
      text: MENU_TEXT,
      keyboard: keyboard([
        ...screens.map(
          (v): Row => [[VIEW_LABEL[v as TaskView], `${TASKS_NS}:v:${v}:0`]],
        ),
        [[`🔎 Spot tasks in jots: ${tasks ? "on" : "off"}`, `${TASKS_NS}:det`]],
        [[`💡 Spot TILs in jots: ${til ? "on" : "off"}`, `${TASKS_NS}:til`]],
        [CLOSE],
      ]),
    };
  }

  /** The task menu as a fresh message: /menu's entry point, which can't edit its own
   *  message into this one. */
  async promptRoot(): Promise<void> {
    log.info("tasks menu opened (via /menu)");
    const { text, keyboard } = await this.menu();
    await this.deps.notifier.send(text, { keyboard });
  }

  async toggle(
    key: Extract<SwitchKey, "taskDetection" | "tilDetection">,
  ): Promise<boolean> {
    const enabled = await this.deps.repo.toggleSetting(key);
    log.info(
      { enabled },
      key === "taskDetection"
        ? "tasks: jot detection toggled"
        : "tasks: TIL detection toggled",
    );
    return enabled;
  }

  /** The morning summary: what's due today plus whatever is still hanging over. A day with
   *  nothing due sends nothing, but a failure still speaks up: a morning with no summary
   *  should only ever mean an empty day. */
  async dailySummary(): Promise<void> {
    const today = plainDate();
    const { notifier } = this.deps;
    log.info({ date: today }, "tasks: sending the daily summary");
    try {
      const { text, keyboard, count } = await this.list(
        "day",
        0,
        `<b>🌅 Your tasks for ${today}</b>`,
      );
      if (count === 0) {
        log.info({ date: today }, "tasks: nothing due today — staying quiet");
        return;
      }
      await notifier.send(text, { html: true, keyboard, silent: false });
      log.info({ date: today, tasks: count }, "tasks: daily summary sent");
    } catch (err) {
      log.error({ err }, "tasks: daily summary failed");
      const why = err instanceof Error ? err.message : String(err);
      await notifier
        .send(`⚠️ Couldn't put together your task summary: ${why}`, {
          silent: false,
        })
        .catch(() => {});
    }
  }
}
