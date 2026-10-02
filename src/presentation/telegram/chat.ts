import { type Api, type Context, InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup, ReactionTypeEmoji } from "grammy/types";
import { logger } from "../../libs/log.ts";
import type { MessageOptions, Notifier } from "../../services/notifier.ts";

const log = logger("chat");

/** `MessageOptions` with the keyboard as grammy builds it. `Notifier` types it structurally
 *  so models stay free of grammy; the views narrow it here. */
export type SendOptions = Omit<MessageOptions, "keyboard"> & {
  keyboard?: InlineKeyboardMarkup;
};

function params({ html, keyboard }: SendOptions = {}) {
  return {
    ...(html ? { parse_mode: "HTML" as const } : {}),
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };
}

/** A new message can also point the compose box at itself or hang off an earlier message;
 *  an edit can do neither. */
function sendParams(opts: SendOptions = {}) {
  return {
    ...params(opts),
    ...(opts.forceReply
      ? { reply_markup: { force_reply: true as const } }
      : {}),
    ...(opts.replyTo
      ? {
          reply_parameters: {
            message_id: opts.replyTo,
            allow_sending_without_reply: true,
          },
        }
      : {}),
  };
}

/** The update being answered: its chat, its message and the tap that led to it. */
export class Responder {
  constructor(private ctx: Context) {}

  /** Stop the tapped button's spinner, with a toast or an alert when there is text. */
  async ack(text?: string, opts: { alert?: boolean } = {}): Promise<void> {
    const other =
      text === undefined
        ? {}
        : opts.alert
          ? { text, show_alert: true }
          : { text };
    await this.ctx.answerCallbackQuery(other);
  }

  /** A new message in this chat; resolves to its id. */
  async reply(text: string, opts?: SendOptions): Promise<number> {
    const sent = await this.ctx.reply(text, sendParams(opts));
    return sent.message_id;
  }

  async remove(): Promise<void> {
    await this.ctx.deleteMessage();
  }

  /** Delete this message; when Telegram refuses (older than 48h, already gone), leave
   *  `fallbackText` with no buttons instead. A failing edit rejects, so callers decide
   *  whether to swallow it. `onClosed` runs first so callers drop their own state for the
   *  message before any await. */
  async closeMessage(
    fallbackText: string,
    onClosed?: () => void,
  ): Promise<void> {
    onClosed?.();
    try {
      await this.remove();
      return;
    } catch (err) {
      log.warn({ err }, "close: delete failed, editing instead");
    }
    // An empty InlineKeyboard clears the buttons; `reply_markup: undefined` is dropped
    // from the JSON payload, so Telegram would leave the old ones tappable.
    await this.ctx.editMessageText(fallbackText, {
      reply_markup: new InlineKeyboard(),
    });
  }
}

export const closeMessage = (
  ctx: Context,
  fallbackText: string,
  onClosed?: () => void,
): Promise<void> => new Responder(ctx).closeMessage(fallbackText, onClosed);

/** The owner's chat: everything the bot says on its own initiative goes through here. */
export class Chat implements Notifier {
  constructor(
    private api: Api,
    private chatId: number,
  ) {}

  async notify(text: string): Promise<void> {
    await this.api.sendMessage(this.chatId, text);
  }

  async send(text: string, opts?: SendOptions): Promise<number> {
    const sent = await this.api.sendMessage(
      this.chatId,
      text,
      sendParams(opts),
    );
    return sent.message_id;
  }

  async edit(
    messageId: number,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    await this.api.editMessageText(this.chatId, messageId, text, params(opts));
  }

  async delete(messageId: number): Promise<void> {
    await this.api.deleteMessage(this.chatId, messageId);
  }

  async react(
    messageId: number,
    emoji: ReactionTypeEmoji["emoji"],
  ): Promise<void> {
    await this.api
      .setMessageReaction(this.chatId, messageId, [{ type: "emoji", emoji }])
      .catch(() => {});
  }

  /** Best-effort "typing…" chat action. Telegram clears it after ~5s on its own. */
  async typing(): Promise<void> {
    await this.api.sendChatAction(this.chatId, "typing").catch(() => {});
  }
}
