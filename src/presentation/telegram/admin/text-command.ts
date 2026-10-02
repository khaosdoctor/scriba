import { fitTelegram } from "../../../libs/text.ts";
import type { AdminService } from "../../../services/admin.ts";
import type { CommandView } from "../commands.ts";

/** An admin command that answers with one text. fitTelegram turns an oversized answer
 *  into a labelled cut instead of a rejected send. */
export function textCommand(
  command: string,
  description: string,
  answer: (admin: AdminService, args: string) => string | Promise<string>,
): CommandView {
  return {
    command,
    description,
    admin: true,
    async run(ctx, { admin }) {
      const text = await answer(admin, String(ctx.match ?? ""));
      await ctx.reply(fitTelegram(text));
    },
  };
}
