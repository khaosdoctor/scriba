import { extname } from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import type { AdminController } from "./controllers/admin.ts";
import { CommandController } from "./controllers/command.ts";
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
  editedJotText,
  embedOffer,
  isEditableJot,
  journalLine,
  parseLiteralEdit,
  setEmbeds,
  stripJournalLine,
} from "./core.ts";
import type { Jot, Repository } from "./db.ts";
import { editConfirmation } from "./lib/jot.ts";
import type { Scheduler } from "./lib/scheduler.ts";
import type { TaskDraft } from "./lib/tasks.ts";
import { logger } from "./log.ts";
import type { Config } from "./models/config.ts";
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

/** All Telegram wiring. Long polling, no webhook. Implements BotServices so the
 *  processor can notify, ask link questions, download files, and apply queued edits. */
export class ScribaBot implements BotServices {
  private bot: Bot;
  private chat: Chat;
  private queue!: FlushQueue;
  private rating: RatingController;
  private habits: HabitController;
  private command: CommandController;
  private tasks: TaskController;
  private jotController: JotController;
  private adminController!: AdminController;

  constructor(
    private config: Config,
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
    // Command and task mode both own the message stream, so neither opens over the other.
    const modes = new Modes(this.chat);
    // /command: an agent session scoped to the vault. It gets no built-in tool that could
    // reach the host; services/agent.ts holds the allow list.
    this.command = new CommandController({
      service: new AgentService(
        new VaultTools(config.vaultPath || null, obsidian),
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
    });
    this.jotController = new JotController({
      repo,
      obsidian,
      notifier: this.chat,
      // The queue is built after this bot (it needs it), so it is read per call.
      queue: { add: (ids) => this.queue.add(ids) },
      squashWindowMs: config.squash.windowMs,
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
      jots: this,
      admin: () => this.adminController,
      errors: {
        jotForMessage: (messageId) => this.repo.jotForMessage(messageId),
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

  awaitVoiceFix(
    jotId: string,
    original: string,
    proposed: string,
  ): Promise<"original" | "proposed"> {
    return this.jotController.awaitVoiceFix(jotId, original, proposed);
  }

  status(jotId: string, html: string, opts?: StatusButtons): Promise<void> {
    return this.jotController.status(jotId, html, opts);
  }

  deleteStatus(jotId: string): Promise<void> {
    return this.jotController.deleteStatus(jotId);
  }

  react(jotId: string, state: "done" | "failed" | "retrying"): Promise<void> {
    return this.jotController.react(jotId, state);
  }

  async typing(): Promise<void> {
    await this.chat.typing();
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error(`no file_path for ${fileId}`);
    // Bot API files go up to 20 MB, so longer than a model call, but never unbounded.
    const res = await fetch(
      `https://api.telegram.org/file/bot${this.config.telegram.token}/${file.file_path}`,
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
