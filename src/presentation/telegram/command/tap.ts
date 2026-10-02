import { type Composer, type Context, InlineKeyboard } from "grammy";
import {
  COMMAND_NS,
  type CommandController,
} from "../../../services/command.ts";
import { Responder } from "../chat.ts";
import { namespace } from "../namespace.ts";

/** `cm:s:<turnId>` is a status message's ⏹ Stop. `cm:y|n:<id>` answers a write/delete
 *  confirmation: the tap is answered and the question marked before the agent is let
 *  through, so the toast never waits on the vault. */
export function commandView(command: CommandController): Composer<Context> {
  return namespace(COMMAND_NS, async (ctx, [verdict, id]) => {
    const responder = new Responder(ctx);
    if (verdict === "s")
      return command.stop(id, (toast) => responder.ack(toast));
    const decide = command.takeConfirmation(id);
    if (!decide) return responder.ack("expired");
    const allowed = verdict === "y";
    try {
      await responder.ack(allowed ? "doing it" : "skipped");
      await ctx
        .editMessageText(
          `${ctx.callbackQuery.message?.text ?? ""}\n${allowed ? "✅ approved" : "❌ declined"}`,
          { reply_markup: new InlineKeyboard() },
        )
        .catch(() => {});
    } finally {
      decide(allowed);
    }
  });
}
