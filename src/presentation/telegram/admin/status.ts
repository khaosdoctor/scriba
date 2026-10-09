import { textCommand } from "./text-command.ts";

export const status = textCommand(
  "status",
  "health snapshot",
  (admin) => admin.status(),
  "/status → which upstreams (models, Obsidian, Telegram, transcription) answer right now",
);
