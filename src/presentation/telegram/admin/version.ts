import { textCommand } from "./text-command.ts";

export const version = textCommand(
  "version",
  "bot version + commit sha",
  (admin) => admin.version(),
  "/version → the running version and the commit it was built from",
);
