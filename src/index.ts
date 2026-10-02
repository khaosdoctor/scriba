import { ScribaBot } from "./bot.ts";
import { AdminController } from "./controllers/admin.ts";
import { ProcessingController } from "./controllers/processing.ts";
import { logger } from "./lib/log.ts";
import { FlushQueue } from "./lib/queue.ts";
import { Scheduler } from "./lib/scheduler.ts";
import { previousDate } from "./lib/time.ts";
import type { Config } from "./models/config.ts";
import { Repository } from "./repositories/index.ts";
import {
  Enricher,
  type EnrichFallback,
  OPENCODE_BASE_URL,
  type SwitchNotifier,
} from "./services/enrich.ts";
import { GithubReleases } from "./services/github.ts";
import { HealthMonitor, upstreams } from "./services/health.ts";
import { ObsidianClient } from "./services/obsidian.ts";
import {
  buildTranscriber,
  type FallbackTranscriber,
} from "./services/transcribe.ts";
import { VaultService } from "./services/vault.ts";

const log = logger("main");

export interface Build {
  version: string;
  sha: string;
}

/** Collaborators a test can replace; each defaults to the real one. */
export interface ExternalServices {
  obsidian?: ObsidianClient;
  enricher?: Enricher;
  transcriber?: FallbackTranscriber;
}

export interface Scriba {
  bot: ScribaBot;
  enricher: Enricher;
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function buildEnricher(
  config: Config,
  repo: Repository,
  notifySwitch: SwitchNotifier,
) {
  const enrichModel =
    (await repo.getSetting("enrichModel")) ?? config.enrich.model;
  const fallbacks: EnrichFallback[] = [];
  if (config.enrich.groqApiKey)
    fallbacks.push({
      apiKey: config.enrich.groqApiKey,
      model: config.enrich.fallbackModel,
      name: "Groq",
    });
  if (config.enrich.opencodeApiKey)
    fallbacks.push({
      apiKey: config.enrich.opencodeApiKey,
      model: config.enrich.opencodeModel,
      baseUrl: OPENCODE_BASE_URL,
      name: "OpenCode",
    });
  log.info(
    {
      model: enrichModel,
      backup: config.enrich.backupModel,
      fallbacks: fallbacks.map((f) => f.name ?? f.model),
    },
    fallbacks.length
      ? `enricher ready with ${fallbacks.length} chat fallback(s)`
      : "enricher ready, no chat fallbacks: jots post un-enriched when both Claude models are unavailable",
  );
  return new Enricher(
    enrichModel,
    undefined,
    fallbacks,
    undefined,
    config.enrich.backupModel,
    config.enrich.timeoutMs,
    undefined,
    notifySwitch,
  );
}

const RETRY_EVERY_MS = 5 * 60_000;

/** Builds and wires everything. Nothing runs until `start()`: no timer is armed and no
 *  update is polled before it. */
export async function createScriba(
  config: Config,
  { version, sha }: Build,
  externalServices: ExternalServices = {},
): Promise<Scriba> {
  const startedAt = Date.now();
  const repo = await Repository.open(config.dbPath);
  log.debug("repository open, migrations applied");

  const obsidian =
    externalServices.obsidian ?? new ObsidianClient(config.obsidian);
  const transcriber =
    externalServices.transcriber ?? buildTranscriber(config.transcription);
  const enricher: Enricher =
    externalServices.enricher ??
    (await buildEnricher(config, repo, (to, model, err) => {
      const reason = err instanceof Error ? err.message : String(err);
      switch (to) {
        case "fallback":
          return bot.notify(
            `⚠️ Enrichment switched to fallback model ${model}. Quality may drop until the chosen model is back.\nReason: ${reason}`,
          );
        case "primary":
          return bot.notify(`✅ Enrichment is back on ${model}.`);
        case "down":
          return bot.notify(
            `⏸ Every enrichment model is down, so new jots are held in place. They go into your journal on their own once one is back.\nReason: ${reason}`,
          );
        default:
          return to satisfies never;
      }
    }));
  const links = new VaultService(config.vaultPath, obsidian);
  const github = new GithubReleases();

  const scheduler = new Scheduler();
  const bot = new ScribaBot(
    config,
    repo,
    obsidian,
    enricher,
    transcriber,
    links,
    scheduler,
  );
  const processing = new ProcessingController({
    repo,
    obsidian,
    transcriber,
    enricher,
    links,
    jots: bot.jotController,
    edits: bot.edits,
    tasks: bot.tasks,
    notifier: bot.chat,
    files: bot.media,
  });
  const queue = new FlushQueue({
    idleMs: config.flush.idleMs,
    maxBatch: config.flush.maxBatch,
    maxWaitMs: config.flush.maxWaitMs,
    onFlush: (ids) => processing.processBatch(ids),
  });
  bot.setQueue(queue);

  const health = new HealthMonitor(
    upstreams(
      {
        groqApiKey: config.enrich.groqApiKey,
        opencodeApiKey: config.enrich.opencodeApiKey,
        obsidianUrl: config.obsidian.url,
        parakeetUrl: config.transcription.parakeetUrl,
      },
      obsidian.dispatcher,
    ),
    (t) => bot.notify(t),
  );
  const admin = new AdminController({
    repo,
    queue,
    processing,
    transcriber,
    links,
    github,
    health,
    notifier: bot,
    build: { version, sha },
    startedAt,
  });
  bot.setAdmin(admin);

  scheduler.daily(
    "summary",
    () => config.summaryTime,
    () => admin.dailySummary(),
  );
  // The next night is armed first, so a prompt that hangs or fails cannot stop the ones
  // after it.
  scheduler.daily(
    "rating",
    () => repo.ratingTime(config.ratingTime),
    () => bot.nightlyRating(),
    { armBeforeRun: true },
  );
  // Fires at 00:00 by default, so the day to review is the one that just ended.
  scheduler.daily(
    "habits",
    () => config.habitsTime,
    () => bot.promptHabits(previousDate()),
  );
  // The one message of the day meant to interrupt: what's due today and what is still
  // hanging over from before.
  scheduler.daily(
    "tasks",
    () => config.tasksTime,
    () => bot.promptTaskSummary(),
  );
  scheduler.every("retry", RETRY_EVERY_MS, () => processing.retryPass());

  return {
    bot,
    enricher,
    async start() {
      const unstuck = await repo.resetProcessing();
      log.info({ requeued: unstuck }, "crash recovery done");
      // First boot only: from then on the DB value wins, changed at runtime via /menu.
      await repo.seedSettings({
        enrichModel: config.enrich.model,
        voiceFixModel: config.voiceFix.model,
      });
      links.startIndex();
      await scheduler.start();
      void processing.retryPass();
      health.start();
      await bot.start();
      log.info("scriba ready");
      await admin.announceDeploy();
    },
    async stop() {
      await bot.stop();
      scheduler.stop();
      health.stop();
      links.stopIndex();
      await repo.close();
    },
  };
}
