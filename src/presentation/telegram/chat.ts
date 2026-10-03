import { type Api, type Context, InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup, ReactionTypeEmoji } from "grammy/types";
import { logger } from "../../libs/log.ts";
import type { MessageOptions, Notifier } from "../../services/notifier.ts";

const log = logger("chat");

type SendOptions = Omit<MessageOptions, "keyboard"> & {
  keyboard?: InlineKeyboardMarkup;
};

function params({ html, keyboard }: SendOptions = {}) {
  return {
    ...(html ? { parse_mode: "HTML" as const } : {}),
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };
}

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
    ...(opts.silent === undefined ? {} : { disable_notification: opts.silent }),
  };
}

export class Responder {
  constructor(private ctx: Context) {}

  async ack(text?: string, opts: { alert?: boolean } = {}): Promise<void> {
    const other =
      text === undefined
        ? {}
        : opts.alert
          ? { text, show_alert: true }
          : { text };
    await this.ctx.answerCallbackQuery(other);
  }

  async dropButtons(prefix: string): Promise<void> {
    const rows = this.ctx.callbackQuery?.message?.reply_markup?.inline_keyboard;
    if (!rows?.length) return;
    const kept = rows
      .map((row) =>
        row.filter(
          (button) =>
            !(
              "callback_data" in button &&
              button.callback_data.startsWith(prefix)
            ),
        ),
      )
      .filter((row) => row.length > 0);
    if (kept.flat().length === rows.flat().length) return;
    await this.ctx.editMessageReplyMarkup({
      reply_markup: { inline_keyboard: kept },
    });
  }

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
    await this.ctx.editMessageText(fallbackText, {
      reply_markup: new InlineKeyboard(),
    });
  }
}

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
