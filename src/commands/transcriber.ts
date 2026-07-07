import type { TranscriberMode } from "../transcribe.ts";
import type { Command } from "./types.ts";

export const transcriber: Command = {
	name: "transcriber",
	description: "show or set the backend — /transcriber [local|remote]",
	run: async (_ctx, args, d) => {
		const arg = args.trim().toLowerCase();
		if (!arg) return `transcriber: ${d.transcriber.mode}`;
		if (arg !== "local" && arg !== "remote")
			return "usage: /transcriber [local|remote]";
		try {
			d.transcriber.setMode(arg as TranscriberMode);
		} catch (e) {
			return `⚠️ ${(e as Error).message}`; // creds missing → mode unchanged
		}
		await d.repo.setSetting("transcriber", arg); // survives restart
		return `🎙 transcriber → ${arg}`;
	},
};
