import { type Composer, type Context, InlineKeyboard } from "grammy";
import { COMMAND_NS, type CommandService } from "../../../services/command.ts";
import { Responder } from "../chat.ts";
import { namespace } from "../namespace.ts";

export function commandView(command: CommandService): Composer<Context> {
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
