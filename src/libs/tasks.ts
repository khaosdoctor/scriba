import type {
  Task,
  TaskDraft,
  TaskState,
  TaskType,
  TaskView,
} from "../domain/task/entity.ts";
import { escapeHtml } from "./text.ts";
import { plainDate } from "./time.ts";

const STATE_ICON: Record<TaskState, string> = {
  open: "☐",
  done: "☑",
  cancelled: "⊘",
};

export const TYPE_LABEL: Record<TaskType, string> = {
  work: "🏢 Work",
  personal: "🏠 Personal",
};

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

export function taskListLine(
  task: Task,
  position: number,
  today = plainDate(),
  max = 160,
): string {
  const late =
    task.state === "open" && task.due && task.due < today ? " ⚠️" : "";
  const dates =
    task.state === "done"
      ? task.completion
        ? ` · done ${task.completion}`
        : ""
      : task.due
        ? ` · due ${task.due}${late}`
        : "";
  const started =
    task.state === "open" && task.start && task.start !== task.due
      ? ` · starts ${task.start}`
      : "";
  const full = task.text || "(no description)";
  const text = full.length > max ? `${full.slice(0, max - 1)}…` : full;
  return `${position}. ${STATE_ICON[task.state]} ${escapeHtml(text)}${dates}${started} <i>${task.type}</i>`;
}

/** Button label for a task row: short enough to survive Telegram's button width. */
export function taskButtonLabel(
  task: Task,
  position: number,
  max = 34,
): string {
  const text = (task.text || "(no description)").replace(/\s+/g, " ");
  const body = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return `${STATE_ICON[task.state]} ${position}. ${body}`;
}

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
