import { textCommand } from "./text-command.ts";

export const jot = textCommand(
  "jot",
  "dump one jot's record — /jot <id>",
  (admin, args) => admin.jotDetail(args),
);
