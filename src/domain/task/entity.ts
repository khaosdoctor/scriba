import { plainDate, shiftDate, weekBounds } from "../../libs/time.ts";

export const TASK_TYPES = ["work", "personal"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const DEFAULT_TASK_TYPE: TaskType = "personal";

export function isTaskType(value: unknown): value is TaskType {
  return TASK_TYPES.includes(value as TaskType);
}

export interface TaskDraft {
  description: string;
  type: TaskType;
  start: string | null;
  due: string | null;
}

export interface TaskDraftRow extends TaskDraft {
  id: string;
  source: "mode" | "jot";
  jot_id: string | null;
  source_date: string;
  status: "pending" | "created" | "cancelled" | "dismissed";
  chat_id: number;
  message_id: number | null;
  created_at: number;
  updated_at: number;
}

/** `- [ ]` open, `- [x]` done, `- [-]` cancelled (terminal, never listed or reopened). */
export type TaskState = "open" | "done" | "cancelled";

export interface Task {
  index: number;
  line: string;
  /** Short digest of `line`, carried in callback data so a tap that arrives after the note
   *  changed underneath is refused instead of ticking whatever is now at that index. */
  fingerprint: string;
  type: TaskType;
  state: TaskState;
  text: string;
  start: string | null;
  due: string | null;
  completion: string | null;
}

export function effectiveStart(task: Task): string | null {
  return task.start ?? task.due;
}

/** The deadline the lists go by. A start moved past the deadline means the task was put
 *  off, so the later of the two counts: otherwise a postponed task stays overdue, and in
 *  the morning summary, until its stale `[due:: ]` is edited too. */
export function effectiveDue(task: Task): string | null {
  if (task.start && task.due && task.start > task.due) return task.start;
  return task.due;
}

export type TaskView =
  | "day"
  | "open"
  | "future"
  | "overdue"
  | "today"
  | "week"
  | "two"
  | "done";

export function filterTasks(
  tasks: Task[],
  view: TaskView,
  today = plainDate(),
): Task[] {
  if (view === "done") {
    return tasks
      .filter((task) => task.state === "done")
      .sort((left, right) =>
        (right.completion ?? "").localeCompare(left.completion ?? ""),
      );
  }
  const [weekStart, weekEnd] = weekBounds(today);
  const inWeek = (date: string | null) =>
    !!date && date >= weekStart && date <= weekEnd;
  const twoWeeks = shiftDate(today, 14);
  const matches: Record<
    Exclude<TaskView, "done">,
    (due: string | null, task: Task) => boolean
  > = {
    day: (due, task) =>
      (!!due && due <= today) || effectiveStart(task) === today,
    open: () => true,
    future: (due) => !!due && due >= today,
    overdue: (due) => !!due && due < today,
    today: (due, task) => due === today || effectiveStart(task) === today,
    week: (due, task) => inWeek(due) || inWeek(effectiveStart(task)),
    two: (due) => !!due && due >= today && due <= twoWeeks,
  };
  const open = tasks.filter((task) => task.state === "open");
  const picked = open.filter((task) => matches[view](effectiveDue(task), task));
  return picked.sort(
    (left, right) =>
      (effectiveDue(left) ?? "9999-99-99").localeCompare(
        effectiveDue(right) ?? "9999-99-99",
      ) ||
      (effectiveStart(left) ?? "").localeCompare(effectiveStart(right) ?? "") ||
      left.text.localeCompare(right.text),
  );
}
