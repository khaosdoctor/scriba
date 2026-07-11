import { logger } from "../log.ts";
import type { TranscriberMode } from "../services/transcribe.ts";
import type { Command } from "./types.ts";

const log = logger("transcriber");

export const transcriber: Command = {
	name: "transcriber",
	description: "show or set the backend — /transcriber [local|remote]",
	run: async (_ctx, args, d) => {
		const arg = args.trim().toLowerCase();
		if (!arg) {
			log.info({ mode: d.transcriber.mode }, "/transcriber: showing mode");
			return `transcriber: ${d.transcriber.mode}`;
		}
		if (arg !== "local" && arg !== "remote") {
			log.warn({ arg }, "/transcriber rejected: bad mode");
			return "usage: /transcriber [local|remote]";
		}
		try {
			d.transcriber.setMode(arg as TranscriberMode);
		} catch (e) {
			log.error({ err: e, arg }, "/transcriber: setMode failed");
			return `⚠️ ${(e as Error).message}`; // creds missing → mode unchanged
		}
		await d.repo.setSetting("transcriber", arg); // survives restart
		log.info({ mode: arg }, "/transcriber: mode changed");
		return `🎙 transcriber → ${arg}`;
	},
};
