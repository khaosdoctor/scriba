import { textCommand } from "./text-command.ts";

export const changelog = textCommand(
  "changelog",
  "what's new — /changelog [version|N]",
  (admin, args) => admin.changelog(args),
  "/changelog 3 → the notes of the last three releases",
);
