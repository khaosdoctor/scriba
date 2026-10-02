import { textCommand } from "./text-command.ts";

export const flush = textCommand(
  "flush",
  "drain the flush queue now",
  (admin) => admin.flush(),
);
