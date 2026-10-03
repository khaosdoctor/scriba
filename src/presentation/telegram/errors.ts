import type { Context, ErrorHandler } from "grammy";
import { statusKeyboard } from "../../libs/jot.ts";
import { logger } from "../../libs/log.ts";
import { errorText } from "../../libs/text.ts";
import type { JotService } from "../../services/jots.ts";
import { Responder } from "./chat.ts";

const log = logger("bot");

export function errorHandler(
  jots: Pick<JotService, "idForMessage">,
): ErrorHandler<Context> {
  return async (err) => {
    const msg = errorText(err.error);
    log.error({ err: err.error }, "bot handler error");
    const responder = new Responder(err.ctx);
    // Telegram caps a toast at 200 characters.
    if (err.ctx.callbackQuery) {
      await responder.ack(`⚠️ ${msg}`.slice(0, 200)).catch(() => {});
      return;
    }
    const messageId = err.ctx.message?.message_id;
    const jotId = messageId
      ? await jots.idForMessage(messageId).catch(() => undefined)
      : undefined;
    await responder
      .reply(`⚠️ Couldn't save that: ${msg}`, {
        keyboard: jotId
          ? statusKeyboard(jotId, { retry: true, discard: true })
          : undefined,
      })
      .catch(() => {});
  };
}
