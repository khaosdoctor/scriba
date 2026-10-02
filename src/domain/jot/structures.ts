import type { JotKind, JotStatus } from "./entity.ts";

export interface IntakeInput {
  kind: JotKind;
  messageId: number;
  sentAt: number;
  /** The entry text: the message as markdown, a caption (`""` when there is none), or
   *  `null` for voice, audio and video notes, which carry no text of their own. */
  rawText: string | null;
  fileId?: string;
  day?: string;
}

export interface EditInput {
  messageId: number;
  text: string;
}

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
