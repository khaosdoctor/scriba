import { Composer, type Context } from "grammy";
import { TASK_ADD_REF } from "../../../services/tasks.ts";
import type { CommandView } from "../commands.ts";

export const TASKADD_EMPTY =
  "I couldn't find anything to do in that — try “/taskadd buy cat sand next week”.";

/** `/taskadd <anything>`: one task from one message, no mode to open or close. With nothing
 *  after the command it asks for the line instead. */
export const taskAddCommand: CommandView = {
  command: "taskadd",
  description: "Add one task in one message: /taskadd <what and when>",
  view({ tasks }) {
    const view = new Composer<Context>();
    view.command("taskadd", async (ctx) => {
      const text = ctx.match.trim();
      if (!text) {
        await ctx.reply(
          `📝 Reply to this message with the task — say when it's due in your own words. ${TASK_ADD_REF}`,
        );
        return;
      }
      if (!(await tasks.quickAdd(text))) await ctx.reply(TASKADD_EMPTY);
    });
    return view;
  },
};
