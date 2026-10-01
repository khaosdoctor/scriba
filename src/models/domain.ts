export type JotKind = "text" | "audio" | "image" | "video";
export type JotSection = "journal" | "til";
export const JOT_STATUSES = [
  "pending", // placeholder written, awaiting processing
  "processing", // claimed by a worker (atomic), in flight
  "done", // enriched + written
  "failed", // last attempt failed; retried until attempts hit the cap
  "abandoned", // gave up (cap or unrecoverable); posted un-enriched
  "deleted", // user removed the line (blank edit or /delete); terminal, never requeued
] as const;
export type JotStatus = (typeof JOT_STATUSES)[number];

/** Finished processing and eligible for reprocess (deleted jots are not). */
export const TERMINAL_STATUSES = [
  "done",
  "failed",
  "abandoned",
] as const satisfies readonly JotStatus[];

export const MAX_ATTEMPTS = 10;

export interface Jot {
  id: string;
  kind: JotKind;
  note_path: string;
  anchor: string;
  time: string;
  raw_text: string | null;
  transcript: string | null;
  proposed_text: string | null;
  section: JotSection;
  asset_path: string | null;
  file_id: string | null;
  status: JotStatus;
  attempts: number;
  error: string | null;
  received_at: number;
  updated_at: number;
}

/** Which task note a task belongs to. Personal is the default for anything not clearly
 *  work. */
export type TaskType = "work" | "personal";
/** Where a draft came from: typed in task mode, or spotted in a journal entry. */
export type TaskDraftSource = "mode" | "jot";
/** `pending` until you decide: `created` once it's in the note, `cancelled` when you drop
 *  one you typed, `dismissed` when you tell scriba a detected one wasn't a task. */
export type TaskDraftStatus = "pending" | "created" | "cancelled" | "dismissed";

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
  source: TaskDraftSource;
  jot_id: string | null;
  type: TaskType;
  description: string;
  start: string | null;
  due: string | null;
  source_date: string;
  status: TaskDraftStatus;
  chat_id: number;
  message_id: number | null;
  created_at: number;
  updated_at: number;
}

/** A task the entry says the author still has to do. The dates are the author's own words
 *  ("next friday", "by the 15th"), resolved against the jot's day by chrono: the model is
 *  never asked what today is, and never asked to do date arithmetic. */
export interface DetectedTask {
  description: string;
  start?: string;
  due?: string;
  type?: string;
}

/** An ambiguous link question waiting on a button tap. */
export interface PendingLink {
  jot_id: string;
  surface: string;
  note: string;
}

export interface DownloadedFile {
  bytes: Uint8Array;
  ext: string;
  mime: string;
}
