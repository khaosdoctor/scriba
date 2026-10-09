import { textCommand } from "./text-command.ts";

export const unstick = textCommand(
  "unstick",
  "reset jots wedged in 'processing'",
  (admin) => admin.unstick(),
  "/unstick → jots left 'processing' by a crash go back to pending for the next sweep",
);
