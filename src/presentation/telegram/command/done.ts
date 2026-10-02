import type { Mode } from "../../../services/modes.ts";
import type { CommandView } from "../commands.ts";

const OFF: Record<Mode, string> = {
  task: "📝 Task mode off — back to journaling.",
  command: "🧭 Command mode off — back to journaling.",
};

/** One /done for both message-stream modes: it closes whichever is open, so there is a
 *  single command to remember rather than one per mode. */
export const done: CommandView = {
  command: "done",
  description: "Close the vault assistant or task session",
  async run(ctx, { modes }) {
    const mode = modes.current();
    if (!mode) {
      await ctx.reply("Command mode isn't open.");
      return;
    }
    modes.close();
    await ctx.reply(OFF[mode]);
  },
};
