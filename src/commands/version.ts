import { logger } from "../log.ts";
import type { Command } from "./types.ts";

const log = logger("version");

export const version: Command = {
	name: "version",
	description: "bot version + commit sha",
	run: async (_ctx, _args, d) => {
		log.info({ version: d.version, sha: d.sha }, "/version command");
		return `scriba ${d.version} (${d.sha.slice(0, 7)})`;
	},
};
