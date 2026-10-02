import { Bot } from "grammy";
import type { AdminController } from "./controllers/admin.ts";
import { CommandController } from "./controllers/command.ts";
import { EditController } from "./controllers/edits.ts";
import { HabitController } from "./controllers/habits.ts";
import { JotController } from "./controllers/jots.ts";
import { Modes } from "./controllers/modes.ts";
import { RatingController } from "./controllers/rating.ts";
import { SettingsController } from "./controllers/settings.ts";
import { TaskController } from "./controllers/tasks.ts";
import { logger } from "./lib/log.ts";
import type { FlushQueue } from "./lib/queue.ts";
import type { Scheduler } from "./lib/scheduler.ts";
import type { Config } from "./models/config.ts";
import type { Repository } from "./repositories/index.ts";
import { AgentService } from "./services/agent.ts";
import type { Enricher } from "./services/enrich.ts";
import type { LinkIndex } from "./services/links.ts";
import { MediaService } from "./services/media.ts";
import type { ObsidianClient } from "./services/obsidian.ts";
import { TaskNotesService } from "./services/task-notes.ts";
import type { FallbackTranscriber } from "./services/transcribe.ts";
import { VaultService } from "./services/vault.ts";
import { WebService } from "./services/web.ts";
import { Chat } from "./views/chat.ts";
import { COMMANDS } from "./views/commands/index.ts";
import { registerViews } from "./views/index.ts";
import { MenuLifetime } from "./views/menu-lifetime.ts";

const log = logger("bot");

/** All Telegram wiring. Long polling, no webhook. */
export class ScribaBot {
  private bot: Bot;
  readonly chat: Chat;
  readonly media: MediaService;
  private queue!: FlushQueue;
  private rating: RatingController;
  private habits: HabitController;
  private command: CommandController;
  readonly tasks: TaskController;
  readonly jotController: JotController;
  readonly edits: EditController;
  private adminController!: AdminController;

  constructor(
    config: Config,
    repo: Repository,
    obsidian: ObsidianClient,
    enricher: Enricher,
    transcriber: FallbackTranscriber,
    links: LinkIndex,
    scheduler: Scheduler,
  ) {
    // grammY waits 500s per API call by default; 60s still covers the 30s long poll.
    this.bot = new Bot(config.telegram.token, {
      client: { timeoutSeconds: 60 },
    });
    this.chat = new Chat(this.bot.api, config.telegram.allowedUserId);
    this.media = new MediaService({
      api: this.bot.api,
      token: config.telegram.token,
      transcriber,
    });
    this.rating = new RatingController({
      repo,
      obsidian,
      notifier: this.chat,
      ratingTime: config.ratingTime,
      headings: {
        journal: config.obsidian.journalHeading,
        til: config.obsidian.tilHeading,
      },
    });
    this.habits = new HabitController({
      obsidian,
      notifier: this.chat,
      heading: config.obsidian.habitsHeading,
    });
    const menus = new MenuLifetime(this.bot.api);
    const settings = new SettingsController({
      repo,
      links,
      enricher,
      scheduler,
      notifier: this.chat,
      ratingTime: config.ratingTime,
    });
    // Command and task mode both own the message stream, so neither opens over the other.
    const modes = new Modes(this.chat);
    // /command: an agent session scoped to the vault. It gets no built-in tool that could
    // reach the host; services/agent.ts holds the allow list.
    this.command = new CommandController({
      service: new AgentService(
        new VaultService(config.vaultPath || null, obsidian),
        new WebService(),
        config.command,
      ),
      notifier: this.chat,
      modes,
    });
    // /task: every message becomes a task in one of the two task notes instead of a jot.
    this.tasks = new TaskController({
      repo,
      notes: new TaskNotesService(obsidian, config.tasks),
      enricher,
      notifier: this.chat,
      modes,
      ownerId: config.telegram.allowedUserId,
      media: this.media,
    });
    this.jotController = new JotController({
      repo,
      obsidian,
      notifier: this.chat,
      // The queue is built after this bot (it needs it), so it is read per call.
      queue: { add: (ids) => this.queue.add(ids) },
      squashWindowMs: config.squash.windowMs,
    });
    this.edits = new EditController({
      repo,
      obsidian,
      enricher,
      jots: this.jotController,
    });
    registerViews(this.bot, {
      ownerId: config.telegram.allowedUserId,
      rating: this.rating,
      habits: this.habits,
      settings,
      menus,
      modes,
      command: this.command,
      tasks: this.tasks,
      jotController: this.jotController,
      edits: this.edits,
      admin: () => this.adminController,
      errors: {
        jotForMessage: (messageId) => repo.jotForMessage(messageId),
      },
    });
  }

  /** Break the wiring cycle: queue + processor are created after this bot (which they need). */
  setQueue(queue: FlushQueue): void {
    this.queue = queue;
  }
  /** Same cycle: the controller notifies through this bot and needs the queue, the
   *  processor and the health monitor, all built after it. */
  setAdmin(admin: AdminController): void {
    this.adminController = admin;
  }

  /** Start long polling. Returns immediately; polling runs in the background. */
  async start(): Promise<void> {
    // Populate the `/` command menu Telegram shows in the compose box.
    await this.bot.api
      .setMyCommands(
        COMMANDS.map(({ command, description }) => ({ command, description })),
      )
      .catch((e) => log.warn({ err: e }, "setMyCommands failed"));
    void this.bot.start({
      allowed_updates: [
        "message",
        "edited_message",
        "callback_query",
        "message_reaction",
      ],
      onStart: (me) =>
        log.info({ username: me.username }, "telegram long polling started"),
    });
  }
  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async notify(text: string): Promise<void> {
    log.debug({ text }, "notify user");
    await this.chat.notify(text);
  }

  /** Nightly rating prompt (the scheduler calls this). Delegates to the rating command. */
  async nightlyRating(): Promise<void> {
    await this.rating.nightly();
  }

  /** Nightly habit review prompt (the scheduler calls this). */
  async promptHabits(date: string): Promise<void> {
    await this.habits.prompt(date);
  }

  /** Morning task summary (the scheduler calls this). Delegates to the task flow. */
  async promptTaskSummary(): Promise<void> {
    await this.tasks.dailySummary();
  }
}
