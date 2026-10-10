import type { Keyboard } from "../libs/keyboard.ts";

export interface MessageOptions {
  html?: boolean;
  keyboard?: Keyboard;
  forceReply?: boolean;
  /** Hint shown in the empty compose box while a force-reply is open (64 chars max). */
  placeholder?: string;
  replyTo?: number;
  silent?: boolean;
}

export interface Notifier {
  notify(text: string): Promise<void>;
  send(text: string, opts?: MessageOptions): Promise<number>;
  edit(messageId: number, text: string, opts?: MessageOptions): Promise<void>;
  delete(messageId: number): Promise<void>;
  react(messageId: number, emoji: string): Promise<void>;
  typing(): Promise<void>;
}
