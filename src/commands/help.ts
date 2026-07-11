import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("help");

/** Built from the live registry so it always lists the real command set. */
export function makeHelp(commands: Command[]): Command {
	return {
		name: "help",
		description: "list admin commands",
		run: async () => {
			log.info({ count: commands.length }, "/help command");
			return [
				"🛠 commands:",
				...commands.map((c) => `/${c.name} — ${c.description}`),
			].join("\n");
		},
	};
}
