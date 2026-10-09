import { textCommand } from "./text-command.ts";

export const rejections = textCommand(
  "rejections",
  "list learned link-rejections — /rejections [page]",
  (admin, args) => admin.rejections(args),
  "/rejections 2 → the second page of word/note pairs you said No to",
);
