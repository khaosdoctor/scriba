import { textCommand } from "./text-command.ts";

export const stats = textCommand(
  "stats",
  "jot counts — /stats [today|week|all]",
  (admin, args) => admin.stats(args),
  "/stats week → how many jots came in over the last 7 days, and how many failed",
);
