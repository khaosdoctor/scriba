import { textCommand } from "./text-command.ts";

export const sweep = textCommand("sweep", "run the retry sweep now", (admin) =>
  admin.retryPass(),
);
