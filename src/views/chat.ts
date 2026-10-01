import { type Context, InlineKeyboard } from "grammy";
import { logger } from "../log.ts";

const log = logger("chat");

/** Delete the tapped message; when Telegram refuses (older than 48h, already gone), leave
 *  `fallbackText` with no buttons instead. A failing edit rejects, so callers decide whether
 *  to swallow it. `onClosed` runs first so callers drop their own state for the message
 *  before any await. */
export async function closeMessage(
  ctx: Context,
  fallbackText: string,
  onClosed?: () => void,
): Promise<void> {
  onClosed?.();
  try {
    await ctx.deleteMessage();
    return;
  } catch (err) {
    log.warn({ err }, "close: delete failed, editing instead");
  }
  // An empty InlineKeyboard clears the buttons; `reply_markup: undefined` is dropped from
  // the JSON payload, so Telegram would leave the old ones tappable.
  await ctx.editMessageText(fallbackText, {
    reply_markup: new InlineKeyboard(),
  });
}
