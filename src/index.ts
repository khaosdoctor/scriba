import { Bot } from "grammy";
import type { Config } from "./config.ts";
import { AdminController } from "./controllers/admin.ts";
import { CommandController } from "./controllers/command.ts";
import { EditController } from "./controllers/edits.ts";
import { HabitController } from "./controllers/habits.ts";
import { JotController } from "./controllers/jots.ts";
import { Modes } from "./controllers/modes.ts";
import { ProcessingController } from "./controllers/processing.ts";
import { RatingController } from "./controllers/rating.ts";
import { SettingsController } from "./controllers/settings.ts";
import { TaskController } from "./controllers/tasks.ts";
import { logger } from "./libs/log.ts";
import { FlushQueue } from "./libs/queue.ts";
import { Scheduler } from "./libs/scheduler.ts";
import { previousDate } from "./libs/time.ts";
import { Repository } from "./repositories/index.ts";
import { AgentService } from "./services/agent.ts";
import {
  Enricher,
  type EnrichFallback,
  OPENCODE_BASE_URL,
  type SwitchNotifier,
} from "./services/enrich.ts";
import { GithubReleases } from "./services/github.ts";
import { HealthMonitor, upstreams } from "./services/health.ts";
import { MediaService } from "./services/media.ts";
import { ObsidianClient } from "./services/obsidian.ts";
import { TaskNotesService } from "./services/task-notes.ts";
import {
  buildTranscriber,
  type FallbackTranscriber,
} from "./services/transcribe.ts";
import { VaultService } from "./services/vault.ts";
import { VoiceService } from "./services/voice.ts";
import { WebService } from "./services/web.ts";
import { Chat } from "./views/chat.ts";
import { publishCommands, registerViews } from "./views/index.ts";
import { MenuLifetime } from "./views/menu-lifetime.ts";

const log = logger("main");
const botLog = logger("bot");

export interface Build {
  version: string;
  sha: string;
}

/** Collaborators a test can replace; each defaults to the real one. */
export interface ExternalServices {
  repo?: Repository;
  obsidian?: ObsidianClient;
  enricher?: Enricher;
  transcriber?: FallbackTranscriber;
  links?: VaultService;
  scheduler?: Scheduler;
  queue?: FlushQueue;
  processing?: ProcessingController;
  health?: HealthMonitor;
  github?: GithubReleases;
}

/** The running app, plus the pieces a test drives directly. */
export interface Scriba {
  bot: Bot;
  enricher: Enricher;
  media: MediaService;
  jotController: JotController;
  edits: EditController;
  tasks: TaskController;
  command: CommandController;
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
  const repo = externalServices.repo ?? (await Repository.open(config.dbPath));
  log.debug("repository open, migrations applied");

  // grammY waits 500s per API call by default; 60s still covers the 30s long poll.
  const bot = new Bot(config.telegram.token, {
    client: { timeoutSeconds: 60 },
  });
  const chat = new Chat(bot.api, config.telegram.allowedUserId);
  const notify = async (text: string) => {
    botLog.debug({ text }, "notify user");
    await chat.notify(text);
  };

  const obsidian =
    externalServices.obsidian ?? new ObsidianClient(config.obsidian);
  const transcriber =
    externalServices.transcriber ?? buildTranscriber(config.transcription);
  const enricher =
    externalServices.enricher ??
    (await buildEnricher(config, repo, (to, model, err) => {
      const reason = err instanceof Error ? err.message : String(err);
      switch (to) {
        case "fallback":
          return notify(
            `⚠️ Enrichment switched to fallback model ${model}. Quality may drop until the chosen model is back.\nReason: ${reason}`,
          );
        case "primary":
          return notify(`✅ Enrichment is back on ${model}.`);
        case "down":
          return notify(
            `⏸ Every enrichment model is down, so new jots are held in place. They go into your journal on their own once one is back.\nReason: ${reason}`,
          );
        default:
          return to satisfies never;
      }
    }));
  const media = new MediaService({
    api: bot.api,
    token: config.telegram.token,
  });
  const voice = new VoiceService({ media, transcriber });
  const links =
    externalServices.links ?? new VaultService(config.vaultPath, obsidian);
  const github = externalServices.github ?? new GithubReleases();
  const scheduler = externalServices.scheduler ?? new Scheduler();
  // Command and task mode both own the message stream, so neither opens over the other.
  const modes = new Modes(chat);
  const queue =
    externalServices.queue ??
    new FlushQueue({
      idleMs: config.flush.idleMs,
      maxBatch: config.flush.maxBatch,
      maxWaitMs: config.flush.maxWaitMs,
      // Built below; the queue never flushes before start().
      onFlush: (ids) => processing.processBatch(ids),
    });

  const jotController = new JotController({
    repo,
    obsidian,
    notifier: chat,
    queue,
    squashWindowMs: config.squash.windowMs,
  });
  const edits = new EditController({
    repo,
    obsidian,
    enricher,
    jots: jotController,
  });
  // /task: every message becomes a task in one of the two task notes instead of a jot.
  const tasks = new TaskController({
    repo,
    notes: new TaskNotesService(obsidian, config.tasks),
    enricher,
    notifier: chat,
    modes,
    ownerId: config.telegram.allowedUserId,
    voice,
  });
  const rating = new RatingController({
    repo,
    obsidian,
    notifier: chat,
    ratingTime: config.ratingTime,
    headings: {
      journal: config.obsidian.journalHeading,
      til: config.obsidian.tilHeading,
    },
  });
  const habits = new HabitController({
    obsidian,
    notifier: chat,
    heading: config.obsidian.habitsHeading,
  });
  // /command: an agent session scoped to the vault. It gets no built-in tool that could
  // reach the host; services/agent.ts holds the allow list.
  const command = new CommandController({
    service: new AgentService(links, new WebService(), config.command),
    notifier: chat,
    modes,
  });
  const settings = new SettingsController({
    repo,
    links,
    enricher,
    scheduler,
    notifier: chat,
    ratingTime: config.ratingTime,
  });
  const processing: ProcessingController =
    externalServices.processing ??
    new ProcessingController({
      repo,
      obsidian,
      transcriber,
      enricher,
      links,
      jots: jotController,
      edits,
      tasks,
      notifier: chat,
      files: media,
    });

  const health =
    externalServices.health ??
    new HealthMonitor(
      upstreams(
        {
          groqApiKey: config.enrich.groqApiKey,
          opencodeApiKey: config.enrich.opencodeApiKey,
          obsidianUrl: config.obsidian.url,
          parakeetUrl: config.transcription.parakeetUrl,
        },
        obsidian.dispatcher,
      ),
      notify,
    );
  const admin = new AdminController({
    repo,
    queue,
    processing,
    transcriber,
    links,
    github,
    health,
    notifier: { notify },
    build: { version, sha },
    startedAt,
  });
  registerViews(bot, {
    ownerId: config.telegram.allowedUserId,
    rating,
    habits,
    settings,
    menus: new MenuLifetime(bot.api),
    modes,
    command,
    tasks,
    jotController,
    edits,
    admin,
    errors: {
      jotForMessage: (messageId) => repo.jotForMessage(messageId),
    },
  });

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
    () => rating.nightly(),
    { armBeforeRun: true },
  );
  // Fires at 00:00 by default, so the day to review is the one that just ended.
  scheduler.daily(
    "habits",
    () => config.habitsTime,
    () => habits.prompt(previousDate()),
  );
  // The one message of the day meant to interrupt: what's due today and what is still
  // hanging over from before.
  scheduler.daily(
    "tasks",
    () => config.tasksTime,
    () => tasks.dailySummary(),
  );
  scheduler.every("retry", RETRY_EVERY_MS, () => processing.retryPass());

  return {
    bot,
    enricher,
    media,
    jotController,
    edits,
    tasks,
    command,
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
      await publishCommands(bot.api);
      void bot.start({
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
          "message_reaction",
        ],
        onStart: (me) =>
          botLog.info(
            { username: me.username },
            "telegram long polling started",
          ),
      });
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
