import { logger } from "../../../libs/log.ts";
import type { CommandView } from "../commands.ts";
import { ROOT_TEXT, rootKeyboard } from "./tap.ts";

const log = logger("reprocess");

export const reprocess: CommandView = {
  command: "reprocess",
  description: "Reprocess jots — a day, a date range, or one jot by id",
  example:
    "/reprocess 1a2b3c4d → enriches that jot again; bare /reprocess opens a day/range picker",
  async run(ctx, { admin }) {
    const id = ctx.match.trim().toLowerCase();
    if (id) {
      log.info({ id }, "reprocess by id");
      const { text } = await admin.reprocessExecute({ jot: id });
      return ctx.reply(text);
    }
    log.info("reprocess menu opened");
    return ctx.reply(ROOT_TEXT, { reply_markup: rootKeyboard() });
  },
};
