import type { Command } from "./types.ts";

export const rejections: Command = {
  name: "rejections",
  description: "list learned link-rejections",
  run: async (_ctx, _args, d) => {
    const list = await d.repo.rejectionList();
    if (!list.length) return "(no rejections)";
    return list.map((r) => `"${r.surface}" ✗ [[${r.note}]]`).join("\n");
  },
};
