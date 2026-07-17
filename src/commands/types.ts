import type { Context } from "grammy";
import type { Repository } from "../db.ts";
import type { JotProcessor } from "../runtime/processor.ts";
import type { FlushQueue } from "../runtime/queue.ts";
import type { GithubReleases } from "../services/github.ts";
import type { LinkIndex } from "../services/links.ts";
import type { TranscriberSwitch } from "../services/transcribe.ts";

/** Everything the admin commands act on. The bot assembles this per invocation. */
export interface Deps {
	repo: Repository;
	queue: FlushQueue;
	processor: JotProcessor;
	transcriber: TranscriberSwitch;
	links: LinkIndex;
	github: GithubReleases;
	version: string;
	sha: string;
	startedAt: number;
}

/** One admin command. `run` returns a string to auto-reply with, or does its own reply
 *  on `ctx` (e.g. inline keyboards) and returns void. */
export interface Command {
	name: string;
	description: string;
	run(ctx: Context, args: string, deps: Deps): Promise<string | void>;
}
