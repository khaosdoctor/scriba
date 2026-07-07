import type { Command } from "./types.ts";

/** Built from the live registry so it always lists the real command set. */
export function makeHelp(commands: Command[]): Command {
  return {
    name: "help",
    description: "list admin commands",
    run: async () => ["🛠 commands:", ...commands.map((c) => `/${c.name} — ${c.description}`)].join("\n"),
  };
}
