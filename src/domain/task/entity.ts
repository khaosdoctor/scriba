export type TaskType = "work" | "personal";

export interface TaskDraft {
  description: string;
  type: TaskType;
  start: string | null;
  due: string | null;
}

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
