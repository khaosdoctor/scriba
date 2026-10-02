import { textCommand } from "./text-command.ts";

export const stats = textCommand(
  "stats",
  "jot counts — /stats [today|week|all]",
  (admin, args) => admin.stats(args),
);
