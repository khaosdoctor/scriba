import type { Mode } from "../../../services/modes.ts";
import type { CommandView } from "../commands.ts";

const OFF: Record<Mode, string> = {
  task: "📝 Task mode off — back to journaling.",
  command: "🧭 Command mode off — back to journaling.",
};

export const done: CommandView = {
  command: "done",
  description: "Close the vault assistant or task session",
  example: "/done → messages go back to the journal",
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
