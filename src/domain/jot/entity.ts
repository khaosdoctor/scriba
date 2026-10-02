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
export const REPROCESSABLE_STATUSES = [
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
