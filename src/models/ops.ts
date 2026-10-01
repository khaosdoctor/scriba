import { z } from "zod";
import type { JotStatus } from "./domain.ts";

/** The fields we read from a GitHub release. */
export const ReleaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  html_url: z.string(),
  published_at: z.string(),
});
export type Release = z.infer<typeof ReleaseSchema>;

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

export interface MessageOptions {
  /** Send with HTML parse mode (the text is already escaped). */
  html?: boolean;
  /** Telegram's inline keyboard markup, typed structurally so models stay free of grammy.
   *  An empty keyboard clears the buttons; none leaves them as they are. */
  keyboard?: { inline_keyboard: readonly (readonly object[])[] };
}

/** The owner's chat as a controller sees it: messages it starts on its own, outside any
 *  reply to an update. `Chat` in views implements it over the Telegram api. */
export interface Notifier {
  /** Plain text to the owner. */
  notify(text: string): Promise<void>;
  /** A message to the owner; resolves to its id so it can be edited later. */
  send(text: string, opts?: MessageOptions): Promise<number>;
  /** Rewrite a message; rejects when Telegram refuses (gone, unchanged, too old). */
  edit(messageId: number, text: string, opts?: MessageOptions): Promise<void>;
  /** Delete a message; rejects when Telegram refuses. */
  delete(messageId: number): Promise<void>;
  /** Set the bot's one reaction on a message, from Telegram's fixed emoji set. Best-effort:
   *  never rejects. */
  react(messageId: number, emoji: string): Promise<void>;
}

/** Which buttons a jot's status message carries. A jot that finishes gets `undo`; one that
 *  fails gets `retry` and `discard`: every failure is a decision, and both halves of it
 *  should be one tap away rather than a command you have to remember. */
export type StatusButtons = {
  retry?: boolean;
  undo?: boolean;
  discard?: boolean;
  /** Line holds a YouTube/tweet/image URL: offer to embed it, or to turn it back into a
   *  link (`embedOffer` in core.ts decides which). */
  embed?: "embed" | "plain";
};
