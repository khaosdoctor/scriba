import { readFileSync } from "node:fs";
import http from "node:http";
import { ScribaBot } from "./bot.ts";
import { config } from "./config.ts";
import {
	ENRICH_MODEL_KEY,
	formatDeployNotice,
	VOICE_FIX_MODEL_KEY,
} from "./core.ts";
import { Repository } from "./db.ts";
import { logger } from "./log.ts";
import { JotProcessor } from "./runtime/processor.ts";
import { FlushQueue } from "./runtime/queue.ts";
import { Scheduler } from "./runtime/scheduler.ts";
import { Enricher } from "./services/enrich.ts";
import { GithubReleases } from "./services/github.ts";
import { LinkIndex } from "./services/links.ts";
import { ObsidianClient } from "./services/obsidian.ts";
import { buildTranscriber } from "./services/transcribe.ts";

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
			vaultIndex: config.vaultPath ?? "(none — REST fallback)",
			port: config.telegram.port,
			logLevel: process.env.LOG_LEVEL ?? "debug",
		},
		"scriba starting",
	);
	// 1. config + open DB
	const repo = await Repository.open(config.dbPath);
	log.debug("repository open, migrations applied");

	// 2. crash recovery
	const unstuck = await repo.resetProcessing(); // crash recovery: unstick jots claimed by a dead run
	log.info({ requeued: unstuck }, "crash recovery done");

	// 2b. Seed DB-backed model settings from env vars (first boot only — the DB
	// value wins from then on, changed at runtime via /menu).
	if (!(await repo.getSetting(ENRICH_MODEL_KEY)))
		await repo.setSetting(ENRICH_MODEL_KEY, config.enrich.model);
	if (!(await repo.getSetting(VOICE_FIX_MODEL_KEY)))
		await repo.setSetting(VOICE_FIX_MODEL_KEY, config.voiceFix.model);

	// 3. build services
	const obsidian = new ObsidianClient(config.obsidian);
	const transcriber = buildTranscriber(config.transcription);
	const enrichModel = await repo.getSetting(ENRICH_MODEL_KEY);
	const enricher = new Enricher(
		enrichModel ?? config.enrich.model,
		undefined,
		config.enrich.groqApiKey
			? { apiKey: config.enrich.groqApiKey, model: config.enrich.fallbackModel }
			: undefined,
		undefined,
		config.enrich.backupModel,
	);
	log.info(
		{
			model: enrichModel ?? config.enrich.model,
			backup: config.enrich.backupModel,
			fallback: config.enrich.groqApiKey ? config.enrich.fallbackModel : "none",
		},
		config.enrich.groqApiKey
			? "enricher ready with Claude backup and Groq fallback"
			: "enricher ready — no GROQ_API_KEY, jots post un-enriched when both Claude models are unavailable",
	);
	const links = new LinkIndex(config.vaultPath);
	links.start();
	const github = new GithubReleases();

	// 4. wire bot ⇄ processor ⇄ queue
	const bot = new ScribaBot(
		repo,
		obsidian,
		enricher,
		transcriber,
		links,
		github,
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
	// Warn in Telegram when enrichment switches models (primary unavailable ⇄
	// recovered). Fires once per transition, not per jot. Late-wired here because the
	// bot exists now. The failure reason (usage exhausted, overload, network blip, bad
	// token, ...) is surfaced inline so the cause is visible without digging through logs.
	enricher.setSwitchNotifier((to, model, err) =>
		bot.notify(
			to === "fallback"
				? `⚠️ Enrichment switched to fallback model ${model}. Quality may drop until the chosen model is back.\nReason: ${err instanceof Error ? err.message : String(err)}`
				: `✅ Enrichment is back on ${model}.`,
		),
	);
	const queue = new FlushQueue({
		idleMs: config.flush.idleMs,
		maxBatch: config.flush.maxBatch,
		maxWaitMs: config.flush.maxWaitMs,
		onFlush: (ids) => processor.processBatch(ids),
	});
	bot.setQueue(queue);

	// 5. scheduler + retry sweep
	const scheduler = new Scheduler(
		repo,
		processor,
		(t) => bot.notify(t),
		(d) => bot.promptRating(d),
		(d) => bot.promptHabits(d),
		() => bot.promptTaskSummary(),
	);
	scheduler.start();

	void processor.retrySweep(); // pick up anything left over from a previous run

	// 6. health server
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

	// 7. start polling
	await bot.start();
	log.info("scriba ready");

	// Notify only on an actual new deploy (version or sha changed since the last boot we
	// recorded), so a plain process/container restart on the same image stays quiet.
	const deployId = `${version}@${sha}`;
	const lastDeployId = await repo.getSetting("deployId");
	if (lastDeployId !== deployId) {
		log.info({ deployId, lastDeployId }, "new deploy detected — notifying");
		// Best-effort: the deploy notice still sends without "what's new" if the GitHub
		// lookup fails (network blip, release not published yet, rate limit).
		const releaseNote = await github.byVersion(version).catch((err) => {
			log.warn(
				{ err, version },
				"release note lookup failed for deploy notice",
			);
			return null;
		});
		// Only record the deploy once the notice actually sends — a transient Telegram
		// outage should retry on the next boot rather than being silently swallowed.
		try {
			await bot.notify(formatDeployNotice(version, sha, releaseNote));
			await repo.setSetting("deployId", deployId);
		} catch (err) {
			log.warn({ err }, "deploy notice failed to send — will retry next boot");
		}
	}

	// 8. shutdown
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
