import type { Command } from "./types.ts";

export const unstick: Command = {
  name: "unstick",
  description: "reset jots wedged in 'processing'",
  run: async (_ctx, _args, d) => {
    const n = await d.repo.resetProcessing();
    return `🔧 unstuck ${n} jot${n === 1 ? "" : "s"}`;
  },
};
