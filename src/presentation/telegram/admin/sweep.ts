import { textCommand } from "./text-command.ts";

export const sweep = textCommand(
  "sweep",
  "run the retry sweep now",
  (admin) => admin.retryPass(),
  "/sweep → every pending or failed jot is processed now instead of on the next sweep",
);
