import { textCommand } from "./text-command.ts";

export const retry = textCommand(
  "retry",
  "requeue failed jots — /retry [id|all]",
  (admin, args) => admin.retry(args),
  "/retry all → every failed jot, given-up ones too, is queued again",
);
