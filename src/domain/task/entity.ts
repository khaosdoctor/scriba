/** Which task note a task belongs to. Personal is the default for anything not clearly
 *  work. */
export type TaskType = "work" | "personal";

/** A task being composed, in task mode or proposed from a jot, before it's written. */
export interface TaskDraft {
  description: string;
  type: TaskType;
  start: string | null;
  due: string | null;
}

/** A task waiting on its confirmation card. Created tasks aren't stored: the task notes
 *  are the source of truth for those. */
export interface TaskDraftRow {
  id: string;
  source: "mode" | "jot";
  jot_id: string | null;
  type: TaskType;
  description: string;
  start: string | null;
  due: string | null;
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
  /** Position among the checklist bullets of its section, stable regardless of state. */
  index: number;
  /** The full raw bullet line, exactly as written in the note. */
  line: string;
  /** Short digest of `line`, carried in callback data so a tap that arrives after the note
   *  changed underneath is refused instead of ticking whatever is now at that index. */
  fingerprint: string;
  type: TaskType;
  state: TaskState;
  /** The description: the bullet minus its checkbox, tag and inline fields. */
  text: string;
  start: string | null;
  due: string | null;
  completion: string | null;
}
