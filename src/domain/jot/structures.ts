import type { JotKind, JotStatus } from "./entity.ts";

/** A message as the intake sees it. */
export interface IntakeInput {
  kind: JotKind;
  messageId: number;
  /** When Telegram received the message, in ms. */
  sentAt: number;
  /** The entry text: the message as markdown, a caption (`""` when there is none), or
   *  `null` for voice, audio and video notes, which carry no text of their own. */
  rawText: string | null;
  fileId?: string;
  /** File the jot under this day's note instead of the day it was sent (the follow-up
   *  after rating yesterday). */
  day?: string;
}

/** An edited message: its id and the new text as markdown (the caption for media, `""`
 *  when it was removed). */
export interface EditInput {
  messageId: number;
  text: string;
}

/** Jot counts over a window, broken down by kind and outcome, for the /stats command. */
export interface Stats {
  total: number;
  text: number;
  audio: number;
  image: number;
  video: number;
  done: number;
  failed: number;
  abandoned: number;
  inflight: number;
}

export type StatusCounts = Record<JotStatus, number>;
