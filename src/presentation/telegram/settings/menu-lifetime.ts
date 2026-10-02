import type { Api } from "grammy";
import { logger } from "../../../libs/log.ts";

const log = logger("menu");

/** A menu is a control panel, not journal content: one minute without a tap and it deletes
 *  itself, so a finished (or abandoned) flow leaves no stale screen with a still-tappable
 *  keyboard in the chat. Every tap restarts the countdown. One root menu per chat: opening
 *  a fresh one retires the previous. All of it is in memory; after a restart an old menu
 *  keeps its keyboard, which is why `menu:` callback bytes never change. */
export class MenuLifetime {
  static readonly TTL_MS = 60_000;
  // chatId -> message id of the last root menu there. Keyed by chat since message ids are
  // only unique per chat.
  private last = new Map<number, number>();
  // "<chatId>:<messageId>" -> its pending self-destruct timer.
  private expiry = new Map<string, NodeJS.Timeout>();

  constructor(private api: Pick<Api, "deleteMessage">) {}

  /** Delete the previous root menu of a chat, if any, before a new one is sent. */
  async retire(chatId: number): Promise<void> {
    const prev = this.last.get(chatId);
    if (prev === undefined) return;
    this.cancel(chatId, prev);
    await this.api.deleteMessage(chatId, prev).catch(() => {});
  }

  /** A root menu was sent: remember it and start its countdown. */
  opened(chatId: number, msgId: number): void {
    this.last.set(chatId, msgId);
    this.touch(chatId, msgId);
  }

  /** (Re)start a menu message's idle countdown: on send and on every tap, so the minute is
   *  measured from the last interaction. */
  touch(chatId: number, msgId: number): void {
    const key = `${chatId}:${msgId}`;
    this.cancel(chatId, msgId);
    const timer = setTimeout(() => {
      this.expiry.delete(key);
      log.info({ chatId, msgId }, "menu: idle, self-destructing");
      // Best-effort: the message may already be gone (closed, deleted by hand, >48h).
      this.api.deleteMessage(chatId, msgId).catch(() => {});
      if (this.last.get(chatId) === msgId) this.last.delete(chatId);
    }, MenuLifetime.TTL_MS);
    // Don't hold the process open just for a menu that nobody is going to tap.
    timer.unref?.();
    this.expiry.set(key, timer);
  }

  /** A menu was closed by hand: stop its countdown, and the chat has nothing left to
   *  retire, whichever menu was last. */
  closed(chatId: number, msgId: number): void {
    this.last.delete(chatId);
    this.cancel(chatId, msgId);
  }

  private cancel(chatId: number, msgId: number): void {
    const key = `${chatId}:${msgId}`;
    const t = this.expiry.get(key);
    if (!t) return;
    clearTimeout(t);
    this.expiry.delete(key);
  }
}
