export interface MessageOptions {
  /** Send with HTML parse mode (the text is already escaped). */
  html?: boolean;
  /** Telegram's inline keyboard markup, typed structurally so services stay free of grammy.
   *  An empty keyboard clears the buttons; none leaves them as they are. */
  keyboard?: { inline_keyboard: readonly (readonly object[])[] };
  /** Point the owner's compose box at this message. */
  forceReply?: boolean;
  /** Thread this message under the owner's message with this id, even once that one is
   *  gone: losing the thread beats losing the message. */
  replyTo?: number;
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
  /** The "typing…" chat action. Best-effort: never rejects. */
  typing(): Promise<void>;
}
