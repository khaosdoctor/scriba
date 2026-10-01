import { extname } from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.ts";
import type { AdminController } from "./controllers/admin.ts";
import { HabitController } from "./controllers/habits.ts";
import { JotController } from "./controllers/jots.ts";
import { Modes } from "./controllers/modes.ts";
import { RatingController } from "./controllers/rating.ts";
import { SettingsController } from "./controllers/settings.ts";
import { TaskController } from "./controllers/tasks.ts";
import {
  anchorLine,
  assetEmbed,
  deleteAnchorLine,
  editConfirmation,
  editedJotText,
  embedOffer,
  entitiesToMarkdown,
  escapeHtml,
  isEditableJot,
  journalLine,
  makeJotId,
  parseLiteralEdit,
  placeholderLine,
  setEmbeds,
  stripJournalLine,
  stripTilPrefix,
  withinSquashWindow,
} from "./core.ts";
import type { Jot, JotKind, JotSection, Repository } from "./db.ts";
import { CommandSession } from "./flows/command.ts";
import type { Scheduler } from "./lib/scheduler.ts";
import type { TaskDraft } from "./lib/tasks.ts";
import { logger } from "./log.ts";
import type { DownloadedFile } from "./models/domain.ts";
import type { StatusButtons } from "./models/ops.ts";
import type { BotServices } from "./runtime/processor.ts";
import type { FlushQueue } from "./runtime/queue.ts";
import { AgentService } from "./services/agent.ts";
import type { Enricher } from "./services/enrich.ts";
import type { LinkIndex } from "./services/links.ts";
import type { ObsidianClient } from "./services/obsidian.ts";
import { TaskNotesService } from "./services/task-notes.ts";
import type { FallbackTranscriber } from "./services/transcribe.ts";
import { VaultTools } from "./services/vault.ts";
import { WebService } from "./services/web.ts";
import { dayBounds, plainDate, plainTime } from "./time.ts";
import { Chat } from "./views/chat.ts";
import { COMMANDS } from "./views/commands/index.ts";
import { taskMessage } from "./views/commands/task.ts";
import { registerViews } from "./views/index.ts";
import { MenuLifetime } from "./views/menu-lifetime.ts";

const log = logger("bot");

const MIME: Record<string, string> = {
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Set (in place of ✍) on a squashed follower's message, marking it as slated to merge
 *  into the previous jot's line. Telegram bots can set at most one reaction per message
 *  (non-Premium), so this replaces rather than joins the receipt ack. Reacting with 🤝
 *  yourself — your own reaction alongside the bot's, a distinct reactor — is the opt-out:
 *  it pulls the jot back out into its own line. Too late once the batch has already
 *  flushed and folded it in. */
const MERGE_EMOJI = "🤝" as const;

/** The buttons under a jot's status message. Empty (which clears any existing keyboard)
 *  when none is asked for, so a message that's no longer actionable stops offering
 *  actions. */
function jotButtons(jotId: string, opts?: StatusButtons): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (opts?.undo) kb.text("↩️ Undo", `un:${jotId}`);
  if (opts?.embed === "embed") kb.text("🖼 Embed", `em:${jotId}:1`);
  if (opts?.embed === "plain") kb.text("🔗 Plain link", `em:${jotId}:0`);
  if (opts?.retry) kb.text("🔄 Retry", `rt:${jotId}`);
  if (opts?.discard) kb.text("🗑 Delete", `dl:${jotId}`);
  return kb;
}

/** All Telegram wiring. Long polling, no webhook. Implements BotServices so the
 *  processor can notify, ask link questions, download files, and apply queued edits. */
export class ScribaBot implements BotServices {
  private bot: Bot;
  private chat: Chat;
  private queue!: FlushQueue;
  private rating: RatingController;
  private habits: HabitController;
  private command: CommandSession;
  private tasks: TaskController;
  private jotController: JotController;
  private adminController!: AdminController;
  // jotId -> the live status message we edit in place through the jot's lifecycle.
  // ponytail: in-memory. On restart the map is empty and status() just posts a fresh
  // message; nothing is lost. Persist it only if that ever proves annoying.
  private statusMsgs = new Map<string, number>();
  // Voice-fix choice: jotId -> resolve callback. The processor awaits this promise while
  // the user picks between original and proposed transcript.
  private voiceFixPending = new Map<
    string,
    (choice: "original" | "proposed") => void
  >();

  constructor(
    private repo: Repository,
    private obsidian: ObsidianClient,
    private enricher: Enricher,
    private transcriber: FallbackTranscriber,
    links: LinkIndex,
    scheduler: Scheduler,
  ) {
    // grammY waits 500s per API call by default; 60s still covers the 30s long poll.
    this.bot = new Bot(config.telegram.token, {
      client: { timeoutSeconds: 60 },
    });
    this.chat = new Chat(this.bot.api, config.telegram.allowedUserId);
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
    // /command: an agent session scoped to the vault. It gets no built-in tool that could
    // reach the host; services/agent.ts holds the allow list.
    this.command = new CommandSession(
      this.bot,
      new AgentService(
        new VaultTools(config.vaultPath || null, obsidian),
        new WebService(),
        config.command,
      ),
    );
    // /task: every message becomes a task in one of the two task notes instead of a jot.
    // It and command mode both own the message stream, so neither opens over the other.
    this.tasks = new TaskController({
      repo,
      notes: new TaskNotesService(obsidian, config.tasks),
      enricher,
      notifier: this.chat,
      modes: new Modes(this.chat, () => this.command.isOpen()),
      ownerId: config.telegram.allowedUserId,
    });
    this.jotController = new JotController({
      repo,
      obsidian,
      notifier: this.chat,
      // The queue is built after this bot (it needs it), so it is read per retry.
      queue: { add: (ids) => this.queue.add(ids) },
    });
    this.command.setBusyCheck(() => this.tasks.isOpen());
    registerViews(this.bot, {
      ownerId: config.telegram.allowedUserId,
      rating: this.rating,
      habits: this.habits,
      settings,
      menus,
      command: this.command,
      tasks: this.tasks,
      jotController: this.jotController,
      jots: this,
      admin: () => this.adminController,
      errors: {
        jotForMessage: (messageId) => this.repo.jotForMessage(messageId),
        failureButtons: (jotId) =>
          jotButtons(jotId, { retry: true, discard: true }),
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

  // --- BotServices ---
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

  async askLink(
    pendingId: string,
    surface: string,
    note: string,
  ): Promise<void> {
    log.debug({ pendingId, surface, note }, "asking user to confirm link");
    const kb = new InlineKeyboard()
      .text("Yes", `lk:y:${pendingId}`)
      .text("No", `lk:n:${pendingId}`);
    await this.chat.send(`Link "${surface}" → [[${note}]]?`, { keyboard: kb });
  }

  /** Propose a task the enricher spotted in a jot: the same confirmation card task mode
   *  uses, so a suggestion is edited and created exactly like one you typed yourself. */
  async askTask(
    draft: TaskDraft,
    jotId: string,
    jotDate: string,
  ): Promise<void> {
    await this.tasks.suggest(draft, jotId, jotDate);
  }

  /** Offer to move a jot the enricher read as a TIL to the TIL section. */
  async askTil(jotId: string, text: string): Promise<void> {
    await this.jotController.askTil(jotId, text);
  }

  /** Show both transcript versions and wait for the user to pick one. Returns
   *  'original' or 'proposed'. Times out to 'original' after 5 minutes. */
  async awaitVoiceFix(
    jotId: string,
    original: string,
    proposed: string,
  ): Promise<"original" | "proposed"> {
    const kb = new InlineKeyboard()
      .text("📝 Use original", `vf:o:${jotId}`)
      .text("✨ Use fixed", `vf:p:${jotId}`);
    const html = [
      "<b>Original transcript:</b>",
      `<i>${escapeHtml(original)}</i>`,
      "",
      "<b>Proposed fix:</b>",
      `<i>${escapeHtml(proposed)}</i>`,
    ].join("\n");
    await this.showStatus(jotId, html, kb);
    return new Promise<"original" | "proposed">((resolve) => {
      this.voiceFixPending.set(jotId, resolve);
      // 5-minute timeout: fall back to original so processing never stalls.
      setTimeout(
        () => {
          if (this.voiceFixPending.delete(jotId)) {
            log.info({ jotId }, "voice fix: timed out, using original");
            resolve("original");
          }
        },
        5 * 60 * 1000,
      );
    });
  }

  /** Create-or-edit the one live status message for a jot. First call sends it and
   *  remembers the message id; later calls edit that same message in place, so the
   *  chat reads as a clean audit trail instead of a stream of notifications.
   *  `undo: true` attaches an undo button, `embed` the embed toggle; `retry`/`discard`
   *  attach the failure pair; otherwise any button is cleared. */
  async status(
    jotId: string,
    html: string,
    opts?: StatusButtons,
  ): Promise<void> {
    await this.showStatus(jotId, html, jotButtons(jotId, opts));
  }

  private async showStatus(
    jotId: string,
    html: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    const existing = this.statusMsgs.get(jotId);
    const opts = { html: true, keyboard };
    if (existing) {
      try {
        await this.chat.edit(existing, html, opts);
        log.debug({ jotId, messageId: existing }, "status edited");
        return;
      } catch (err) {
        log.warn(
          { jotId, messageId: existing, err },
          "status edit failed, sending a fresh one",
        );
      }
    }
    const messageId = await this.chat.send(html, opts);
    this.statusMsgs.set(jotId, messageId);
    // Map the bot's status message to the jot too, so a reply to it edits the jot
    // just like a reply to the original message (e.g. the transcribed audio note).
    await this.repo.mapMessage(messageId, jotId);
    log.debug({ jotId, messageId }, "status message sent");
  }

  /** Delete a jot's live status message, if it has one. Best-effort: used on a squash
   *  to collapse any stray per-follower message into the leader's single confirmation. */
  async deleteStatus(jotId: string): Promise<void> {
    const messageId = this.statusMsgs.get(jotId);
    if (!messageId) return;
    this.statusMsgs.delete(jotId);
    await this.repo.unmapMessage(messageId); // no stale reply-map to a gone message
    try {
      await this.chat.delete(messageId);
      log.info({ jotId, messageId }, "deleted stray status message (squash)");
    } catch (err) {
      log.warn({ jotId, messageId, err }, "failed to delete status message");
    }
  }

  /** Swap the intake reaction on a jot's message to reflect its outcome.
   *  Telegram only allows a fixed emoji set for reactions, so ⏳/✅/❌ aren't
   *  available — ✍ (received), 👌 (done), 🤔 (retrying), 😱 (failed) are the closest. */
  async react(
    jotId: string,
    state: "done" | "failed" | "retrying",
  ): Promise<void> {
    const messageId = await this.repo.messageForJot(jotId);
    if (!messageId) return;
    const emoji = state === "done" ? "👌" : state === "retrying" ? "🤔" : "😱";
    await this.chat.react(messageId, emoji);
  }

  async typing(): Promise<void> {
    await this.chat.typing();
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error(`no file_path for ${fileId}`);
    // Bot API files go up to 20 MB, so longer than a model call, but never unbounded.
    const res = await fetch(
      `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ext = (extname(file.file_path).slice(1) || "bin").toLowerCase();
    log.debug({ fileId, ext, bytes: bytes.length }, "downloaded telegram file");
    return { bytes, ext, mime: MIME[ext] ?? "application/octet-stream" };
  }

  /** Apply edits that were queued while this jot was still processing. */
  async onJotDone(jotId: string): Promise<void> {
    const edits = await this.repo.queuedEdits(jotId);
    if (!edits.length) return;
    const jot = await this.repo.getJot(jotId);
    if (!jot) return;
    log.info(
      { jotId, count: edits.length },
      "applying edits queued during processing",
    );
    const confirmation = await this.applyEdits(jot, edits);
    await this.repo.clearQueuedEdits(jotId); // clear only after apply succeeds, so a throw doesn't lose them
    // Edit the jot's own status message in place rather than posting a new one — the
    // chat keeps a single, already-updated message per jot instead of the stale
    // "done" confirmation sitting alongside a separate "edited" one.
    await this.status(
      jotId,
      `${confirmation}\n(applied ${edits.length} queued edit${edits.length > 1 ? "s" : ""})`,
      { undo: true, embed: await this.embedFor(jot) },
    );
  }

  // --- handlers the views call back into ---

  // Edit an existing jot in place if it's already processed, otherwise queue
  // the edit for when processing finishes. Clearing the message to empty/whitespace
  // is the delete gesture (Telegram never delivers an actual message delete), so a
  // blank edit removes the journal line instead of replacing it.
  async applyMessageEdit(ctx: any, edited: string): Promise<void> {
    const jotId = await this.repo.jotForMessage(ctx.editedMessage.message_id);
    if (!jotId) return;
    const jot = await this.repo.getJot(jotId);
    if (!jot) return;
    const markdown = editedJotText(jot.section, edited);
    const blank = markdown.trim().length === 0;
    if (!isEditableJot(jot.status)) {
      // "delete" is the instruction applyEdits recognises when onJotDone drains the
      // queue, so an in-flight jot is deleted the moment its line is first written.
      log.info(
        { jotId, status: jot.status, blank },
        `${blank ? "delete" : "edit"} queued (jot still processing)`,
      );
      await this.repo.queueEdit(jotId, blank ? "delete" : markdown);
      return void ctx.reply(
        blank
          ? "⏳ still processing — I'll remove it once it's done."
          : "⏳ still processing — I'll apply that edit once it's done.",
      );
    }
    // Both branches edit the jot's own status message in place (this.status) rather
    // than posting a new reply, so the chat ends up with the single, already-updated
    // message instead of the stale confirmation sitting alongside a fresh one.
    if (blank) {
      log.info({ jotId }, "edited message cleared — removing journal line");
      await this.status(jotId, "🗑️ got it — removing…");
      return void this.status(jotId, await this.deleteJot(jot));
    }
    log.info({ jotId, text: markdown }, "applying edit to processed jot");
    await this.status(jotId, "✍️ got your edit — applying…");
    await this.status(jotId, await this.replaceJotText(jot, markdown), {
      undo: true,
      embed: await this.embedFor(jot),
    });
  }

  /** A voice note sent while task mode is open. It is transcribed like any other voice
   *  jot and then read as a task — dictating a task is the whole point of task mode being
   *  a mode rather than a command with arguments. */
  async spokenTask(ctx: any, fileId: string): Promise<void> {
    await ctx.react("✍").catch(() => {});
    const file = await this.downloadFile(fileId);
    const text = await this.transcriber.transcribe(file.bytes, file.ext);
    log.info({ chars: text.length }, "task mode: voice note transcribed");
    await taskMessage(ctx, this.tasks, text);
  }

  /** Attachment intake (image/video): save + embed the file, keeping the caption as the
   *  jot's text (an image's caption is the entry itself; a video's is its embed display).
   *  Returns the intake promise so a rejection reaches bot.catch. */
  intakeMedia(ctx: any, kind: JotKind, fileId: string): Promise<void> {
    const markdown = entitiesToMarkdown(
      ctx.message.caption ?? "",
      ctx.message.caption_entities,
    );
    return this.intake(ctx, kind, { fileId, rawText: markdown });
  }

  async intake(
    ctx: any,
    kind: JotKind,
    src: { rawText?: string; fileId?: string; day?: string },
  ): Promise<void> {
    // `day` files the jot under another day's note (the follow-up after rating yesterday):
    // the last second of that day, so it reads as the day's final entry.
    const sent = ctx.message.date * 1000;
    const epochMs =
      src.day && src.day !== plainDate(sent)
        ? dayBounds(src.day)[1] - 1000
        : sent;
    const id = makeJotId();
    const date = plainDate(epochMs);
    const time = plainTime(epochMs);
    // dailyPath is pure (no REST call), so the row can be persisted even when Obsidian is
    // down. ensureDailyNote + the placeholder write happen after, and writeLine recreates
    // the note on flush, so a failed placeholder self-heals.
    const notePath = this.obsidian.dailyPath(date);
    const tilText = kind === "text" ? stripTilPrefix(src.rawText ?? "") : null;
    const section: JotSection = tilText === null ? "journal" : "til";
    const rawText = tilText ?? src.rawText;

    // Squash a rapid burst: a text/voice jot arriving within the squash window of the
    // previous still-pending text/voice jot in this note folds into that jot's line —
    // it shares the leader's anchor and skips its own placeholder, so the processor
    // (which groups by anchor) enriches them into one line. Ordering never changes: the
    // leader's placeholder is already in place. Attach-only kinds never squash. Decided
    // before the ack reaction below, so a squashed follower gets the 🤝 marker on the
    // same react() call instead of a second round-trip.
    let anchor = id;
    let squashed = false;
    // A follow-up answer (`day`) is stamped with the day's last second, so two of them would
    // always look like one burst: they are deliberate entries and never squash.
    if (!src.day && (kind === "text" || kind === "audio")) {
      const prev = await this.repo.lastPendingEnrichableJot(notePath, section);
      if (
        prev &&
        withinSquashWindow(prev.received_at, epochMs, config.squash.windowMs)
      ) {
        anchor = prev.anchor;
        squashed = true;
        log.info(
          { id, into: anchor, gapMs: epochMs - prev.received_at },
          "jot squashed into open run",
        );
      }
    }

    // Ack receipt with a reaction (✍ = received/awaiting) — best-effort, intake
    // proceeds if it fails. Swapped to 👌/😱 by react() once processing settles. A
    // squashed follower gets 🤝 instead, marking it for merge; reacting with 🤝
    // yourself pulls it back out (handleMergeReaction). Telegram bots can set only one
    // reaction per message (non-Premium) — setting both here would silently no-op.
    await ctx.react(squashed ? MERGE_EMOJI : "✍").catch(() => {});
    log.info(
      { id, kind, date, time, hasFile: !!src.fileId, hasText: !!src.rawText },
      "jot received",
    );

    const now = Date.now();
    const jot: Jot = {
      id,
      kind,
      note_path: notePath,
      anchor,
      time,
      raw_text: rawText ?? null,
      transcript: null,
      proposed_text: null,
      section,
      asset_path: null,
      file_id: src.fileId ?? null,
      status: "pending",
      attempts: 0,
      error: null,
      received_at: epochMs,
      updated_at: now,
    };
    // Insert the DB row (pending) BEFORE writing the placeholder line. A crash between the
    // two then leaves a row with no line — which self-heals, since writeLine falls back to
    // appendJournalLine on a missing anchor. The reverse (a line with no row) would orphan
    // a placeholder no sweep can find.
    await this.repo.insertJot(jot);
    // Map the message BEFORE the network write below so the jot is retryable even if the
    // placeholder write throws (Obsidian down): bot.catch finds this jot by message id and
    // offers a retry button. Queueing stays last so ordering matches the normal path.
    await this.repo.mapMessage(ctx.message.message_id, id);
    // A squashed follower reuses the leader's placeholder — writing its own would add a
    // second line the processor would then have to reconcile away.
    if (squashed) {
      log.debug({ id, anchor }, "squashed — reusing leader placeholder");
    } else {
      await this.obsidian.ensureDailyNote(date);
      await this.obsidian.appendJournalLine(
        date,
        placeholderLine(time, id),
        section,
      );
      log.debug({ id, notePath }, "placeholder line written");
    }
    this.queue.add([id]);
    log.debug({ id }, "jot queued for flush");
  }

  /** The user tapping 🤝 on a squashed follower's own message — opting it out of the
   *  merge. Only takes effect while the jot is still pending; `unsquash` is the
   *  compare-and-swap that enforces that atomically, so a tap racing the leader's flush
   *  loses cleanly rather than double-posting the follower's text. */
  async handleMergeReaction(ctx: any): Promise<void> {
    if (!ctx.reactions().emojiAdded.includes(MERGE_EMOJI)) return;
    const messageId = ctx.messageReaction?.message_id;
    const jotId = messageId
      ? await this.repo.jotForMessage(messageId)
      : undefined;
    if (!jotId) return;
    const jot = await this.repo.getJot(jotId);
    if (!jot || jot.anchor === jot.id) return; // not a squashed follower, nothing to opt out of
    if (!(await this.repo.unsquash(jotId))) {
      log.info(
        { jotId },
        "merge opt-out too late — already folded into the leader",
      );
      await this.notify("🤝 too late — that one's already merged in.");
      return;
    }
    log.info(
      { jotId, formerLeader: jot.anchor },
      "merge opt-out — jot pulled back into its own line",
    );
    await this.obsidian.ensureDailyNote(plainDate(jot.received_at));
    await this.obsidian.appendJournalLine(
      plainDate(jot.received_at),
      placeholderLine(jot.time, jotId),
      jot.section,
    );
    await ctx.react("✍").catch(() => {});
  }

  async handleEdit(ctx: any): Promise<void> {
    const jotId = await this.repo.jotForMessage(
      ctx.message.reply_to_message.message_id,
    );
    if (!jotId) return void ctx.reply("Can't find that jot to edit.");
    const jot = await this.repo.getJot(jotId);
    if (!jot) return void ctx.reply("Jot not found.");
    const instruction: string = ctx.message.text;

    // Editable only once a line exists (done or abandoned); otherwise it still needs
    // processing, so queue the edit and let onJotDone apply it after.
    if (!isEditableJot(jot.status)) {
      log.info(
        { jotId, status: jot.status },
        "edit queued (jot still processing)",
      );
      await this.repo.queueEdit(jotId, instruction);
      return void ctx.reply(
        "⏳ still processing — I'll apply that edit once it's done.",
      );
    }
    log.info({ jotId, instruction }, "applying edit");
    // Edit the jot's own status message in place rather than posting a new reply, so
    // the chat ends up with the single, already-updated message instead of the stale
    // confirmation sitting alongside a fresh one.
    const applied = await this.applyEdits(jot, [instruction]);
    // A freeform instruction can itself be "delete this", so only offer Undo when the
    // entry is actually still in the journal.
    const after = await this.repo.getJot(jotId);
    const done = after?.status === "done";
    await this.status(jotId, applied, {
      undo: done,
      embed: done ? await this.embedFor(jot) : undefined,
    });
  }

  /** The embed toggle an edited jot's status message should offer, read off the line as
   *  it now is in the note — an edit can add, remove or embed a URL, so the offer made
   *  when the jot first finished may no longer hold. */
  private async embedFor(jot: Jot): Promise<StatusButtons["embed"]> {
    const note = await this.obsidian.readNote(jot.note_path);
    const line = anchorLine(note, jot.anchor);
    return line ? embedOffer(stripJournalLine(line, jot.time)) : undefined;
  }

  /** Apply one or more edit instructions to a jot's line, merged into a single write
   *  (and a single agent call for the freeform ones). Returns a short status. */
  private async applyEdits(jot: Jot, instructions: string[]): Promise<string> {
    // deleteJot takes the note lock itself, so it must run before the lock below.
    if (instructions.some((i) => i.trim().toLowerCase() === "delete"))
      return this.deleteJot(jot);
    const result = await this.obsidian.updateLine(
      jot.note_path,
      jot.anchor,
      async (line, write) => {
        let text = stripJournalLine(line, jot.time);
        const freeform: string[] = [];
        for (const ins of instructions) {
          const lit = parseLiteralEdit(ins);
          if (lit)
            text = text.replaceAll(lit.old, lit.new); // deterministic, free
          else freeform.push(ins);
        }
        // Merge all freeform edits into one agent call rather than one per instruction.
        if (freeform.length)
          text = await this.enricher.editText(text, freeform.join("; then "));
        write(journalLine(jot.time, text, jot.anchor));
        return text;
      },
    );
    if (result === null) return "Couldn't find that line in the note.";
    await this.syncEditedSource(jot, result);
    return editConfirmation(jot.time, result);
  }

  /** Replace a jot's entire text content (for edited messages, not instructions). The new
   *  text is only the message's text/caption, so a media jot's embed is re-appended —
   *  editing an image's caption must not drop the image out of the note. */
  private async replaceJotText(jot: Jot, newText: string): Promise<string> {
    const content = [newText, assetEmbed(jot)].filter(Boolean).join(" ");
    const found = await this.obsidian.updateLine(
      jot.note_path,
      jot.anchor,
      (_line, write) => {
        write(journalLine(jot.time, content, jot.anchor));
        return true;
      },
    );
    if (!found) return "Couldn't find that line in the note.";
    await this.syncEditedSource(jot, newText);
    return editConfirmation(jot.time, newText);
  }

  /** Fold a corrected line's text back into the jot's own source field (`transcript` for
   *  audio, `raw_text` for text) so a later /reprocess builds on the fix instead of
   *  reverting to the original mis-transcription/typo — e.g. correcting a voice note's
   *  "bake" to "cake" via `s/bake/cake/` used to only touch the journal line; reprocessing
   *  afterwards re-transcribed the same audio and lost the fix. Scoped to a standalone
   *  jot (not a squashed leader/follower): a squashed line is several jots' sources
   *  combined into one, so there's no single field to fold the edited text back into
   *  without duplicating or dropping a follower's content. */
  private async syncEditedSource(jot: Jot, text: string): Promise<void> {
    if (jot.kind !== "audio" && jot.kind !== "text") return;
    if (jot.anchor !== jot.id) return; // squashed follower — no single source to update
    if ((await this.repo.groupFollowers(jot.id)).length > 0) return; // squashed leader
    const field = jot.kind === "audio" ? "transcript" : "raw_text";
    await this.repo.updateJot(jot.id, { [field]: text });
    log.info(
      { jotId: jot.id, field },
      "edit folded back into jot source for future reprocessing",
    );
  }

  /** Remove a jot's line from its daily note and mark it deleted (a terminal state, so a
   *  retry sweep never resurrects it). Shared by the blank-edit path, /delete and the
   *  menu's jots browser. */
  async deleteJot(jot: Jot): Promise<string> {
    const out = await this.obsidian.updateNote(jot.note_path, (note, write) => {
      const removed = deleteAnchorLine(note, jot.anchor);
      if (removed !== null) write(removed);
      return removed;
    });
    // Line already gone (double delete, or removed by hand in Obsidian)? Still mark it
    // deleted so the record matches reality — the user's intent is satisfied.
    if (out === null)
      log.warn(
        { jotId: jot.id, anchor: jot.anchor },
        "delete: anchored line not found — marking deleted anyway",
      );
    await this.repo.markDeleted(jot.id);
    // A squashed line is several jots sharing one anchor, so removing it takes the
    // followers' text with it — mark them deleted too rather than leave rows pointing at
    // a line that no longer exists.
    for (const f of await this.repo.groupFollowers(jot.id))
      await this.repo.markDeleted(f.id);
    if (out !== null) log.info({ jotId: jot.id }, "journal line deleted");
    return "🗑️ removed that from your journal.";
  }

  /** /delete: reply to a jot's message to remove its journal line. Mirrors the reply-edit
   *  flow — queues the delete if the jot is still processing. */
  async handleDeleteCommand(ctx: any): Promise<void> {
    const reply = ctx.message?.reply_to_message;
    if (!reply) {
      log.warn("delete command without a reply target");
      return void ctx.reply(
        "Reply to a journal message with /delete to remove that line.",
      );
    }
    const jotId = await this.repo.jotForMessage(reply.message_id);
    if (!jotId) {
      log.warn(
        { messageId: reply.message_id },
        "delete: no jot for that message",
      );
      return void ctx.reply("Can't find a jot for that message.");
    }
    const jot = await this.repo.getJot(jotId);
    if (!jot) {
      log.warn({ jotId }, "delete: jot not found");
      return void ctx.reply("Jot not found.");
    }
    if (!isEditableJot(jot.status)) {
      log.info(
        { jotId, status: jot.status },
        "delete queued (jot still processing)",
      );
      await this.repo.queueEdit(jotId, "delete");
      return void ctx.reply(
        "⏳ still processing — I'll remove it once it's done.",
      );
    }
    log.info({ jotId }, "delete command — removing journal line");
    // Edit the jot's own status message in place — see applyMessageEdit's blank-edit
    // branch for why (single up-to-date message, not a stale one plus a new one).
    await this.status(jotId, await this.deleteJot(jot));
  }

  /** ↩️ Undo on a finished jot, 🗑 Delete on a failed one — the same teardown either way:
   *  pull the line back out of the journal and put the jot in a state the retry sweep
   *  won't resurrect. Same as `/delete`, one tap away while the entry is on screen. */
  async handleRemove(
    ctx: any,
    jotId: string | undefined,
    source: "undo" | "discard",
  ): Promise<void> {
    const jot = jotId ? await this.repo.getJot(jotId) : undefined;
    if (!jot) {
      log.warn({ jotId, source }, "remove: jot is gone");
      return void ctx.answerCallbackQuery({ text: "gone" });
    }
    if (jot.status === "deleted") {
      log.warn({ jotId, source }, "remove: already removed");
      return void ctx.answerCallbackQuery({
        text: source === "undo" ? "already undone" : "already deleted",
      });
    }
    log.info({ jotId, source, status: jot.status }, "jot removal requested");
    await ctx.answerCallbackQuery({
      text: source === "undo" ? "undoing" : "deleting",
    });
    const result = await this.deleteJot(jot);
    // status() with no opts clears the buttons, so a second tap can't re-run it.
    await this.status(jot.id, result);
  }

  /** 🖼 Embed / 🔗 Plain link on a finished jot whose line has a YouTube, tweet or image
   *  URL: rewrite those URLs as `![](url)` embeds or back to links, token-free. The
   *  button then offers the opposite, so the choice can be undone with the next tap. */
  async handleEmbed(
    ctx: any,
    jotId: string | undefined,
    embed: boolean,
  ): Promise<void> {
    const jot = jotId ? await this.repo.getJot(jotId) : undefined;
    if (!jot || jot.status !== "done") {
      log.warn({ jotId, status: jot?.status }, "embed: jot not editable");
      return void ctx.answerCallbackQuery({ text: "gone" });
    }
    const text = await this.obsidian.updateLine(
      jot.note_path,
      jot.anchor,
      (line, write) => {
        const next = setEmbeds(stripJournalLine(line, jot.time), embed);
        write(journalLine(jot.time, next, jot.anchor));
        return next;
      },
    );
    if (text === null) {
      log.warn({ jotId }, "embed: anchored line not found");
      return void ctx.answerCallbackQuery({ text: "line not found" });
    }
    log.info({ jotId, embed }, "embed toggled");
    await ctx.answerCallbackQuery({ text: embed ? "embedded" : "plain link" });
    await this.syncEditedSource(jot, text);
    await this.status(jot.id, editConfirmation(jot.time, text), {
      undo: true,
      embed: embedOffer(text),
    });
  }

  /** 🔄 Retry on a failed jot's status message: reset its attempts and queue it now,
   *  rather than waiting for the sweep. */
  async handleRetry(ctx: any, jotId?: string): Promise<void> {
    const jot = jotId ? await this.repo.getJot(jotId) : undefined;
    if (!jot) {
      log.warn({ jotId }, "retry: jot is gone");
      return void ctx.answerCallbackQuery({ text: "gone" });
    }
    // 🗑 Delete sits right next to this button, so a stray tap must not put back the
    // line the user just took out.
    if (jot.status === "deleted") {
      log.warn({ jotId }, "retry: jot was deleted");
      return void ctx.answerCallbackQuery({ text: "deleted — not retrying" });
    }
    log.info({ jotId, status: jot.status }, "manual retry requested");
    await this.repo.resetForRetry(jot.id);
    this.queue.add([jot.id]);
    await ctx.answerCallbackQuery({ text: "retrying" });
    await ctx.editMessageText("🔄 retrying…");
  }

  /** Voice-fix button: `vf:o:<jotId>` picks original, `vf:p:<jotId>` picks proposed. */
  async handleVoiceFix(
    ctx: any,
    verdict?: string,
    jotId?: string,
  ): Promise<void> {
    if (!jotId || !verdict) return void ctx.answerCallbackQuery();
    const resolve = this.voiceFixPending.get(jotId);
    if (!resolve) {
      log.warn(
        { jotId },
        "voice fix: no pending choice (timed out or duplicate)",
      );
      return void ctx.answerCallbackQuery({ text: "expired" });
    }
    this.voiceFixPending.delete(jotId);
    const choice = verdict === "p" ? "proposed" : "original";
    log.info({ jotId, choice }, "voice fix: user picked");
    await ctx.answerCallbackQuery({
      text: choice === "proposed" ? "using fixed version" : "keeping original",
    });
    resolve(choice);
  }

  async handleLink(ctx: any, verd?: string, pid?: string): Promise<void> {
    if (!pid) return void ctx.answerCallbackQuery();
    const rec = await this.repo.takePendingLink(pid);
    if (!rec) return void ctx.answerCallbackQuery({ text: "expired" });

    if (verd === "n") {
      log.info(
        { surface: rec.surface, note: rec.note },
        "link rejected — learning it",
      );
      await this.repo.reject(rec.surface, rec.note);
      await ctx.answerCallbackQuery({ text: "won't link again" });
      return void ctx.editMessageText(
        `✋ "${rec.surface}" ✗ [[${rec.note}]] (won't ask again)`,
      );
    }

    const jot = await this.repo.getJot(rec.jot_id);
    const applied =
      jot !== undefined &&
      (await this.obsidian.updateLine(
        jot.note_path,
        jot.anchor,
        (line, write) => {
          const linked = line.replace(
            rec.surface,
            `[[${rec.note}|${rec.surface}]]`,
          );
          write(linked);
          return linked !== line;
        },
      )) === true;
    log.info(
      { surface: rec.surface, note: rec.note, applied },
      "link confirmation handled",
    );
    await ctx.answerCallbackQuery({ text: applied ? "linked" : "no change" });
    await ctx.editMessageText(
      applied
        ? `🔗 "${rec.surface}" → [[${rec.note}]]`
        : `"${rec.surface}": nothing to link`,
    );
  }
}
