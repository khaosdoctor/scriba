import { logger } from "../../../libs/log.ts";
import { TASK_ADD_REF } from "../../../services/tasks.ts";
import type { CommandView } from "../commands.ts";

const log = logger("tasks-flow");

export const TASKADD_EMPTY =
  "I couldn't find anything to do in that — try “/taskadd buy cat sand next week”.";

export const taskAddCommand: CommandView = {
  command: "taskadd",
  description: "Add one task in one message: /taskadd <what and when>",
  async run(ctx, { tasks }) {
    const text = ctx.match.trim();
    if (!text) {
      log.info("/taskadd with no text — asking for it");
      await ctx.reply(
        `📝 Reply to this message with the task — say when it's due in your own words. ${TASK_ADD_REF}`,
      );
      return;
    }
    if (!(await tasks.quickAdd(text))) await ctx.reply(TASKADD_EMPTY);
  },
};
