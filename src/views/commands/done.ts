import { Composer, type Context } from "grammy";
import type { CommandView } from "./index.ts";

/** One /done for both message-stream modes: it closes whichever is open, so there is a
 *  single command to remember rather than one per mode. */
export const done: CommandView = {
  command: "done",
  description: "Close the vault assistant or task session",
  view({ tasks, command }) {
    const view = new Composer<Context>();
    view.command("done", async (ctx) => {
      if (!tasks.isOpen()) return command.finish(ctx);
      tasks.finish();
      await ctx.reply("📝 Task mode off — back to journaling.");
    });
    return view;
  },
};
