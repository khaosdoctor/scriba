import { ScribaBot } from "./bot.ts";
import {
  ENRICH_MODEL_KEY,
  formatDeployNotice,
  RATING_TIME_KEY,
  ratingTime,
  VOICE_FIX_MODEL_KEY,
} from "./core.ts";
import { Repository } from "./db.ts";
import { Scheduler } from "./lib/scheduler.ts";
import { logger } from "./log.ts";
import type { Config } from "./models/config.ts";
import { JotProcessor } from "./runtime/processor.ts";
import { FlushQueue } from "./runtime/queue.ts";
import {
  Enricher,
  type EnrichFallback,
  OPENCODE_BASE_URL,
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
export interface Seams {
  obsidian?: ObsidianClient;
  enricher?: Enricher;
  transcriber?: FallbackTranscriber;
}

export interface Scriba {
  bot: ScribaBot;
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function buildEnricher(config: Config, repo: Repository) {
  const enrichModel =
    (await repo.getSetting(ENRICH_MODEL_KEY)) ?? config.enrich.model;
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
  );
}

/** Builds and wires everything. Nothing runs until `start()`: no timer is armed and no
 *  update is polled before it. */
export async function createScriba(
  config: Config,
  { version, sha }: Build,
  seams: Seams = {},
): Promise<Scriba> {
  const startedAt = Date.now();
  const repo = await Repository.open(config.dbPath);
  log.debug("repository open, migrations applied");

  const obsidian = seams.obsidian ?? new ObsidianClient(config.obsidian);
  const transcriber =
    seams.transcriber ?? buildTranscriber(config.transcription);
  const enricher = seams.enricher ?? (await buildEnricher(config, repo));
  const links = new VaultService(config.vaultPath, obsidian);
  const github = new GithubReleases();

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
  enricher.setSwitchNotifier((to, model, err) => {
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
  });
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
    () => bot.promptTaskSummary(),
  );
  scheduler.setRatingTime(
    ratingTime(await repo.getSetting(RATING_TIME_KEY), config.ratingTime),
  );
  bot.setScheduler(scheduler);

  // Probes are plain GETs to a host or a /models listing, never a call that generates
  // anything.
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
  bot.setHealth(health);

  // Notify only on an actual new deploy (version or sha changed since the last boot we
  // recorded), so a plain restart on the same image stays quiet.
  async function announceDeploy(): Promise<void> {
    const deployId = `${version}@${sha}`;
    const lastDeployId = await repo.getSetting("deployId");
    if (lastDeployId === deployId) return;
    log.info({ deployId, lastDeployId }, "new deploy detected, notifying");
    // The notice still goes out without "what's new" when the GitHub lookup fails.
    const releaseNote = await github.byVersion(version).catch((err) => {
      log.warn(
        { err, version },
        "release note lookup failed for deploy notice",
      );
      return null;
    });
    // Recorded only once the notice sends, so a Telegram outage retries on the next boot.
    try {
      await bot.notify(formatDeployNotice(version, sha, releaseNote));
      await repo.setSetting("deployId", deployId);
    } catch (err) {
      log.warn({ err }, "deploy notice failed to send, will retry next boot");
    }
  }

  return {
    bot,
    async start() {
      const unstuck = await repo.resetProcessing();
      log.info({ requeued: unstuck }, "crash recovery done");
      // First boot only: from then on the DB value wins, changed at runtime via /menu.
      if (!(await repo.getSetting(ENRICH_MODEL_KEY)))
        await repo.setSetting(ENRICH_MODEL_KEY, config.enrich.model);
      if (!(await repo.getSetting(VOICE_FIX_MODEL_KEY)))
        await repo.setSetting(VOICE_FIX_MODEL_KEY, config.voiceFix.model);
      links.startIndex();
      scheduler.start();
      void processor.retrySweep();
      health.start();
      await bot.start();
      log.info("scriba ready");
      await announceDeploy();
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
