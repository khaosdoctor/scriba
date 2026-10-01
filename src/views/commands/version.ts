import { textCommand } from "./text-command.ts";

export const version = textCommand(
  "version",
  "bot version + commit sha",
  (admin) => admin.version(),
);
