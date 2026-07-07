import type { Command } from "./types.ts";

export const sweep: Command = {
  name: "sweep",
  description: "run the retry sweep now",
  run: async (_ctx, _args, d) => {
    await d.processor.retrySweep();
    return "🧹 sweep done";
  },
};
