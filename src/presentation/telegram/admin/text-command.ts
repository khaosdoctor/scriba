import { fitTelegram } from "../../../libs/text.ts";
import type { AdminService } from "../../../services/admin.ts";
import type { CommandView } from "../commands.ts";

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
