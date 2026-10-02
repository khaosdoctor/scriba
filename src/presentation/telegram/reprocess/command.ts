import { logger } from "../../../libs/log.ts";
import type { CommandView } from "../commands.ts";
import { ROOT_TEXT, rootKeyboard } from "./tap.ts";

const log = logger("reprocess");

export const reprocess: CommandView = {
  command: "reprocess",
  description: "Reprocess jots — a day, a date range, or one jot",
  run(ctx) {
    log.info("reprocess menu opened");
    return ctx.reply(ROOT_TEXT, { reply_markup: rootKeyboard() });
  },
};
