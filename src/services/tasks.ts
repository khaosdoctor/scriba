import type { SettingsRepository } from "../data/repositories/settings.ts";
import type { TaskDraftRepository } from "../data/repositories/task-drafts.ts";
import type { TaskNoteRepository } from "../data/repositories/task-notes.ts";
import type { SwitchKey } from "../domain/setting/entity.ts";
import {
  draftFromDetection,
  parseTaskDate,
  parseTaskDraft,
} from "../domain/task/draft.ts";
import {
  filterTasks,
  type TaskDraft,
  type TaskDraftRow,
  type TaskType,
  type TaskView,
} from "../domain/task/entity.ts";
import type { DetectedTask } from "../domain/task/structures.ts";
import {
  type Keyboard,
  keyboard,
  NO_BUTTONS,
  type Row,
} from "../libs/keyboard.ts";
import { logger } from "../libs/log.ts";
import { paginate } from "../libs/page.ts";
import {
  type TaskField,
  type TaskRef,
  TYPE_LABEL,
  taskButtonLabel,
  taskCard,
  taskListLine,
  taskRef,
  VIEW_LABEL,
} from "../libs/tasks.ts";
import { errorText, escapeHtml, fitTelegram, shortId } from "../libs/text.ts";
import { plainDate } from "../libs/time.ts";
import type { Enricher } from "./enrich.ts";
import type { Modes, OpenOutcome } from "./modes.ts";
import type { Notifier } from "./notifier.ts";
import type { VoiceService } from "./voice.ts";

const log = logger("tasks-flow");
const processorLog = logger("processor");

export const TASKS_NS = "tk";

export type AnswerOutcome =
  | "ok"
  | "settled"
  | "noText"
  | "noTask"
  | "nothing"
  | "badDate"
  | "needsDue";

export type Screen = { text: string; keyboard: Keyboard };

export interface TaskDeps {
  repo: TaskDraftRepository;
  settings: SettingsRepository;
  notes: TaskNoteRepository;
  enricher: Enricher;
  notifier: Pick<Notifier, "notify" | "send" | "edit" | "delete">;
  modes: Modes;
  ownerId: number;
  voice: Pick<VoiceService, "transcribe">;
}

const PAGE = 8;

const CLOSE: Row[number] = ["✖ Close", `${TASKS_NS}:close`];

const MENU_TEXT =
  "🗂 Tasks\n\nTap a list to see it. Tapping a task in an open list ticks it off; the done list reopens one.";

const PROMPTS: Record<TaskField, string> = {
  d: "✏️ Reply to this message with what the task should say.",
  s: "📅 Reply to this message with the start date — a date, “next monday”, or “none” to leave it to the deadline.",
  u: "🏁 Reply to this message with the due date — a date, or something like “next friday”. This one it needs.",
};

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

export class TaskService {
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

  spokenTask(fileId: string): Promise<string> {
    return this.deps.voice.transcribe(fileId);
  }

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

  async draftsFor(
    detected: DetectedTask[],
    jotId: string,
    day: string,
  ): Promise<TaskDraft[]> {
    if (!detected?.length) return [];
    if (!(await this.deps.settings.getSetting("taskDetection"))) {
      processorLog.debug(
        { id: jotId },
        "task detection off — suggestions dropped",
      );
      return [];
    }
    if (await this.deps.repo.taskDraftsForJot(jotId)) {
      processorLog.info(
        { id: jotId, tasks: detected.length },
        "task detection: this jot was already asked about — not asking again",
      );
      return [];
    }
    const drafts = detected
      .map((task) => draftFromDetection(task, day))
      .filter((draft) => draft.description.trim());
    processorLog.info(
      {
        id: jotId,
        count: drafts.length,
        tasks: drafts.map(
          (draft) => `${draft.description} (due ${draft.due ?? "?"})`,
        ),
      },
      `task detection: ${drafts.length} task(s) found in this jot`,
    );
    return drafts;
  }

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
      id: shortId(),
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

  private async settle(row: TaskDraftRow, html: string): Promise<void> {
    const { notifier } = this.deps;
    const text = fitTelegram(html);
    if (!row.message_id)
      return void (await notifier.send(text, { html: true }).catch(() => {}));
    await notifier
      .edit(row.message_id, text, {
        html: true,
        keyboard: NO_BUTTONS,
      })
      .catch((err) =>
        log.warn({ err, draft: row.id }, "task card settle failed"),
      );
  }

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
  async claim(row: TaskDraftRow): Promise<"claimed" | "noDue" | "lost"> {
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
      const why = errorText(err);
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

  async ask(
    row: TaskDraftRow,
    field: TaskField,
    fromTap = false,
  ): Promise<void> {
    log.info({ draft: row.id, field }, "task: prompting for a field");
    const id = await this.deps.notifier
      .send(
        `${PROMPTS[field]} ${taskRef(field, row.id)}`,
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
    const pageCallback = (target: number) => `${TASKS_NS}:v:${view}:${target}`;
    const nav: Row = [];
    if (shown.page > 0) nav.push(["‹ Prev", pageCallback(shown.page - 1)]);
    if (shown.page < shown.pages - 1)
      nav.push(["Next ›", pageCallback(shown.page + 1)]);
    const total = tasks.length;
    const summary = total
      ? `${total} task${total === 1 ? "" : "s"}${shown.pages > 1 ? ` · page ${shown.page + 1}/${shown.pages}` : ""} · tap one to ${view === "done" ? "reopen it" : "tick it off"}`
      : "Nothing here.";
    const lines = shown.items.map((task, position) =>
      taskListLine(task, shown.offset + position + 1, today),
    );
    return {
      text: fitTelegram(
        [header ?? `<b>${VIEW_LABEL[view]}</b>`, summary, "", ...lines].join(
          "\n",
        ),
      ),
      keyboard: keyboard([
        ...shown.items.map(
          (task, position): Row => [
            [
              taskButtonLabel(task, shown.offset + position + 1),
              `${TASKS_NS}:${task.state === "done" ? "r" : "k"}:${task.type}:${task.index}:${task.fingerprint}:${view}:${shown.page}`,
            ],
          ],
        ),
        ...(nav.length ? [nav] : []),
        [["‹ Tasks", `${TASKS_NS}:m`]],
        [CLOSE],
      ]),
      count: total,
    };
  }

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
    const { settings } = this.deps;
    const tasks = await settings.getSetting("taskDetection");
    const til = await settings.getSetting("tilDetection");
    const screens = Object.keys(VIEW_LABEL).filter((view) => view !== "future");
    return {
      text: MENU_TEXT,
      keyboard: keyboard([
        ...screens.map(
          (view): Row => [
            [VIEW_LABEL[view as TaskView], `${TASKS_NS}:v:${view}:0`],
          ],
        ),
        [[`🔎 Spot tasks in jots: ${tasks ? "on" : "off"}`, `${TASKS_NS}:det`]],
        [[`💡 Spot TILs in jots: ${til ? "on" : "off"}`, `${TASKS_NS}:til`]],
        [CLOSE],
      ]),
    };
  }

  async promptRoot(): Promise<void> {
    log.info("tasks menu opened (via /menu)");
    const { text, keyboard } = await this.menu();
    await this.deps.notifier.send(text, { keyboard });
  }

  async toggle(
    key: Extract<SwitchKey, "taskDetection" | "tilDetection">,
  ): Promise<boolean> {
    const enabled = await this.deps.settings.toggleSetting(key);
    log.info(
      { enabled },
      key === "taskDetection"
        ? "tasks: jot detection toggled"
        : "tasks: TIL detection toggled",
    );
    return enabled;
  }

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
      const why = errorText(err);
      await notifier
        .send(`⚠️ Couldn't put together your task summary: ${why}`, {
          silent: false,
        })
        .catch(() => {});
    }
  }
}
