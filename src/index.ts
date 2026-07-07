import { readFileSync } from "node:fs";
import http from "node:http";
import { ScribaBot } from "./bot.ts";
import { config } from "./config.ts";
import { Repository } from "./db.ts";
import { Enricher } from "./enrich.ts";
import { LinkIndex } from "./index-links.ts";
import { logger } from "./log.ts";
import { ObsidianClient } from "./obsidian.ts";
import { JotProcessor } from "./processor.ts";
import { FlushQueue } from "./queue.ts";
import { Scheduler } from "./scheduler.ts";
import { type TranscriberMode, TranscriberSwitch } from "./transcribe.ts";

const log = logger("main");

const { version } = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const sha = process.env.GIT_SHA ?? "unknown";

async function main(): Promise<void> {
	const startedAt = Date.now();
	log.info({ version, sha }, "scriba boot");
	log.info(
		{
			dbPath: config.dbPath,
			transcriber: config.transcription.mode,
			vaultIndex: config.vaultPath ?? "(none — REST fallback)",
			port: config.telegram.port,
			logLevel: process.env.LOG_LEVEL ?? "debug",
		},
		"scriba starting",
	);
	const repo = await Repository.open(config.dbPath);
	log.debug("repository open, migrations applied");
	const unstuck = await repo.resetProcessing(); // crash recovery: unstick jots claimed by a dead run
	log.info({ requeued: unstuck }, "crash recovery done");

	const obsidian = new ObsidianClient(config.obsidian);
	// A /transcriber choice persisted in the DB overrides the TRANSCRIBER env default;
	// fall back to the env mode if the saved one can't be built (e.g. its creds are gone).
	const savedMode = (await repo.getSetting("transcriber")) as
		| TranscriberMode
		| undefined;
	let transcriber: TranscriberSwitch;
	try {
		transcriber = new TranscriberSwitch(
			config.transcription,
			savedMode ?? (config.transcription.mode as TranscriberMode),
		);
	} catch (e) {
		log.warn(
			{ err: e, savedMode },
			"saved transcriber mode unusable — falling back to env default",
		);
		transcriber = new TranscriberSwitch(
			config.transcription,
			config.transcription.mode as TranscriberMode,
		);
	}
	const enricher = new Enricher();
	const links = new LinkIndex(config.vaultPath);
	links.start();

	const bot = new ScribaBot(
		repo,
		obsidian,
		enricher,
		transcriber,
		links,
		version,
		sha,
		startedAt,
	);
	const processor = new JotProcessor(
		repo,
		obsidian,
		transcriber,
		enricher,
		links,
		bot,
	);
	bot.setProcessor(processor);
	const queue = new FlushQueue({
		idleMs: config.flush.idleMs,
		maxBatch: config.flush.maxBatch,
		maxWaitMs: config.flush.maxWaitMs,
		onFlush: (ids) => processor.processBatch(ids),
	});
	bot.setQueue(queue);

	const scheduler = new Scheduler(
		repo,
		processor,
		(t) => bot.notify(t),
		(d) => bot.promptRating(d),
		(d) => bot.promptHabits(d),
	);
	scheduler.start();

	void processor.retrySweep(); // pick up anything left over from a previous run

	// Long polling needs no inbound webhook; this server exists only for a health check.
	const server = http.createServer((req, res) => {
		if (req.url === "/health") {
			res.writeHead(200).end("ok");
			return;
		}
		res.writeHead(404).end();
	});
	server.listen(config.telegram.port, () =>
		log.info({ port: config.telegram.port }, "health endpoint listening"),
	);

	await bot.start();
	log.info("scriba ready");

	const shutdown = async (signal: string) => {
		log.info({ signal }, "shutting down");
		await bot.stop();
		server.close();
		scheduler.stop();
		links.stop();
		await repo.close();
		log.info("shutdown complete");
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
	log.error({ err }, "fatal");
	process.exit(1);
});
