import type { Context, ErrorHandler, InlineKeyboard } from "grammy";
import { logger } from "../log.ts";
import { Responder } from "./chat.ts";

const log = logger("bot");

export type ErrorDeps = {
  /** The jot a failing message already created, when intake got that far. */
  jotForMessage(messageId: number): Promise<string | undefined>;
  /** The Retry / Delete pair a failed jot's reply carries. */
  failureButtons(jotId: string): InlineKeyboard;
};

/** `bot.catch`: a failed tap gets its spinner stopped with a toast; a failed message gets a
 *  reply, with the failure buttons when a jot row exists for it. */
export function errorHandler({
  jotForMessage,
  failureButtons,
}: ErrorDeps): ErrorHandler<Context> {
  return async (err) => {
    const msg =
      err.error instanceof Error ? err.error.message : String(err.error);
    log.error({ err: err.error }, "bot handler error");
    const responder = new Responder(err.ctx);
    // Telegram caps a toast at 200 characters.
    if (err.ctx.callbackQuery) {
      await responder.ack(`⚠️ ${msg}`.slice(0, 200)).catch(() => {});
      return;
    }
    const messageId = err.ctx.message?.message_id;
    const jotId = messageId
      ? await jotForMessage(messageId).catch(() => undefined)
      : undefined;
    await responder
      .reply(`⚠️ Couldn't save that: ${msg}`, {
        keyboard: jotId ? failureButtons(jotId) : undefined,
      })
      .catch(() => {});
  };
}
