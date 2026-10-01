import type {
  Task,
  TaskDraft,
  TaskState,
  TaskType,
  TaskView,
} from "../../lib/tasks.ts";
import { escapeHtml } from "../../lib/text.ts";
import { plainDate } from "../../time.ts";

export const STATE_ICON: Record<TaskState, string> = {
  open: "☐",
  done: "☑",
  cancelled: "⊘",
};

export const TYPE_LABEL: Record<TaskType, string> = {
  work: "🏢 Work",
  personal: "🏠 Personal",
};

/** Header for a list view, so a screen says what it's showing. */
export const VIEW_LABEL: Record<TaskView, string> = {
  day: "🌅 Today and overdue",
  open: "📋 All open tasks",
  future: "🔭 Open tasks ahead",
  overdue: "⏰ Overdue",
  today: "📅 Due today",
  week: "🗓 This week",
  two: "📆 Next two weeks",
  done: "✅ Done",
};

/** One task as a chat line: its state, its dates and its text. HTML parse mode. Long
 *  descriptions are clipped: a real one runs to a few hundred characters, and eight of
 *  those would push the message past what Telegram accepts. */
export function taskListLine(
  t: Task,
  n: number,
  today = plainDate(),
  max = 160,
): string {
  const late = t.state === "open" && t.due && t.due < today ? " ⚠️" : "";
  const dates =
    t.state === "done"
      ? t.completion
        ? ` · done ${t.completion}`
        : ""
      : t.due
        ? ` · due ${t.due}${late}`
        : "";
  const started =
    t.state === "open" && t.start && t.start !== t.due
      ? ` · starts ${t.start}`
      : "";
  const full = t.text || "(no description)";
  const text = full.length > max ? `${full.slice(0, max - 1)}…` : full;
  return `${n}. ${STATE_ICON[t.state]} ${escapeHtml(text)}${dates}${started} <i>${t.type === "work" ? "work" : "personal"}</i>`;
}

/** Button label for a task row: short enough to survive Telegram's button width. */
export function taskButtonLabel(t: Task, n: number, max = 34): string {
  const text = (t.text || "(no description)").replace(/\s+/g, " ");
  const body = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return `${STATE_ICON[t.state]} ${n}. ${body}`;
}

/** The confirmation card: what will be written, before anything is. HTML parse mode. */
export function taskCard(draft: TaskDraft, header = "📝 New task"): string {
  return [
    header,
    "",
    `<b>${escapeHtml(draft.description || "(no description yet)")}</b>`,
    "",
    `Type: ${TYPE_LABEL[draft.type]}`,
    `Start: ${draft.start ?? draft.due ?? "—"}`,
    `Due: ${draft.due ?? "— <i>(needed)</i>"}`,
  ].join("\n");
}
