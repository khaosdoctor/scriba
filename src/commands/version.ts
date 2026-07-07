import type { Command } from "./types.ts";

export const version: Command = {
	name: "version",
	description: "bot version + commit sha",
	run: async (_ctx, _args, d) => `scriba ${d.version} (${d.sha.slice(0, 7)})`,
};
