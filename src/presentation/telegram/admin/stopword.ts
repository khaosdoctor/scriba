import { textCommand } from "./text-command.ts";

export const stopword = textCommand(
  "stopword",
  "manage stopwords — /stopword add|del|list [word|page]",
  (admin, args) => admin.stopwords(args),
);
