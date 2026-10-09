import { textCommand } from "./text-command.ts";

export const jot = textCommand(
  "jot",
  "dump one jot's record — /jot <id>",
  (admin, args) => admin.jotDetail(args),
  "/jot 1a2b3c4d → that jot's status, attempts, note, error and text",
);
