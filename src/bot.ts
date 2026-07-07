import { Bot, InlineKeyboard } from "grammy";
import { extname } from "node:path";
import { config } from "./config.ts";
import type { Repository, Jot, JotKind } from "./db.ts";
import type { ObsidianClient } from "./obsidian.ts";
import type { Enricher } from "./enrich.ts";
import type { FlushQueue } from "./queue.ts";
import type { BotServices, DownloadedFile } from "./processor.ts";
import { makeJotId, placeholderLine, journalLine, anchorLine, replaceAnchorLine, deleteAnchorLine, parseLiteralEdit } from "./core.ts";
import { plainDate, plainTime } from "./time.ts";
import { RatingCommand, RATING_NS } from "./commands/rating.ts";
import { logger } from "./log.ts";

const log = logger("bot");

const MIME: Record<string, string> = {
  oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

/** All Telegram wiring. Long polling, no webhook. Implements BotServices so the
 *  processor can notify, ask link questions, download files, and apply queued edits. */
export class ScribaBot implements BotServices {
  private bot: Bot;
  private queue!: FlushQueue;
  private rating: RatingCommand;

  constructor(
    private repo: Repository,
    private obsidian: ObsidianClient,
    private enricher: Enricher,
  ) {
    this.bot = new Bot(config.telegram.token);
    this.rating = new RatingCommand(this.bot, repo, obsidian);
    this.registerHandlers();
  }

  /** Break the wiring cycle: queue is created after the processor, which needs this bot. */
  setQueue(queue: FlushQueue): void {
    this.queue = queue;
  }

  /** Start long polling. Returns immediately; polling runs in the background. */
  async start(): Promise<void> {
    void this.bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: (me) => log.info({ username: me.username }, "telegram long polling started"),
    });
  }
  async stop(): Promise<void> {
    await this.bot.stop();
  }

  // --- BotServices ---
  async notify(text: string): Promise<void> {
    log.debug({ text }, "notify user");
    await this.bot.api.sendMessage(config.telegram.allowedUserId, text);
  }

  /** Nightly rating prompt (the scheduler calls this). Delegates to the rating command. */
  async promptRating(date: string): Promise<void> {
    await this.rating.prompt(date);
  }

  async askLink(pendingId: string, surface: string, note: string): Promise<void> {
    log.debug({ pendingId, surface, note }, "asking user to confirm link");
    const kb = new InlineKeyboard().text("Yes", `lk:y:${pendingId}`).text("No", `lk:n:${pendingId}`);
    await this.bot.api.sendMessage(config.telegram.allowedUserId, `Link "${surface}" → [[${note}]]?`, { reply_markup: kb });
  }

  async askRetry(jotId: string, text: string): Promise<void> {
    log.debug({ jotId }, "offering retry button");
    const kb = new InlineKeyboard().text("🔄 Retry", `rt:${jotId}`);
    await this.bot.api.sendMessage(config.telegram.allowedUserId, text, { reply_markup: kb });
  }

  /** Swap the intake reaction on a jot's message to reflect its outcome.
   *  Telegram only allows a fixed emoji set for reactions, so ⏳/✅/❌ aren't
   *  available — ✍ (received), 👌 (done), 🤔 (retrying), 😱 (failed) are the closest. */
  async react(jotId: string, state: "done" | "failed" | "retrying"): Promise<void> {
    const messageId = await this.repo.messageForJot(jotId);
    if (!messageId) return;
    const emoji = state === "done" ? "👌" : state === "retrying" ? "🤔" : "😱";
    await this.bot.api.setMessageReaction(config.telegram.allowedUserId, messageId, [{ type: "emoji", emoji }]).catch(() => {});
  }

  /** Best-effort "typing…" chat action. Telegram clears it after ~5s on its own. */
  async typing(): Promise<void> {
    await this.bot.api.sendChatAction(config.telegram.allowedUserId, "typing").catch(() => {});
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error(`no file_path for ${fileId}`);
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ext = (extname(file.file_path).slice(1) || "bin").toLowerCase();
    log.debug({ fileId, ext, bytes: bytes.length }, "downloaded telegram file");
    return { bytes, ext, mime: MIME[ext] ?? "application/octet-stream" };
  }

  /** Apply edits that were queued while this jot was still processing. */
  async onJotDone(jotId: string): Promise<void> {
    const edits = await this.repo.takeQueuedEdits(jotId);
    if (!edits.length) return;
    const jot = await this.repo.getJot(jotId);
    if (!jot) return;
    log.info({ jotId, count: edits.length }, "applying edits queued during processing");
    await this.applyEdits(jot, edits);
    await this.notify(`✏️ Applied ${edits.length} queued edit${edits.length > 1 ? "s" : ""}.`);
  }

  // --- handlers ---
  private registerHandlers(): void {
    // Surface handler errors back to the user instead of dying silently.
    this.bot.catch(async (err) => {
      const msg = err.error instanceof Error ? err.error.message : String(err.error);
      log.error({ err: err.error }, "bot handler error");
      await err.ctx.reply(`⚠️ Couldn't save that: ${msg}`).catch(() => {});
    });

    // single-user allowlist — everyone else is ignored
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id === config.telegram.allowedUserId) await next();
    });

    this.bot.command("start", (ctx) => ctx.reply("scriba ready. Send text or a voice note to journal."));
    this.rating.register();

    this.bot.on("message:text", async (ctx) => {
      if (ctx.message.text.startsWith("/")) return;
      if (ctx.message.reply_to_message) return this.handleEdit(ctx);
      await this.intake(ctx, "text", { rawText: ctx.message.text });
    });

    this.bot.on("message:voice", (ctx) => this.intake(ctx, "audio", { fileId: ctx.message.voice.file_id }));
    this.bot.on("message:audio", (ctx) => this.intake(ctx, "audio", { fileId: ctx.message.audio.file_id }));

    // Image/video are attachments: saved and embedded, caption kept, not transcribed.
    this.bot.on("message:photo", (ctx) => this.intake(ctx, "image", { fileId: ctx.message.photo.at(-1)!.file_id, rawText: ctx.message.caption }));
    this.bot.on("message:video", (ctx) => this.intake(ctx, "video", { fileId: ctx.message.video.file_id, rawText: ctx.message.caption }));
    this.bot.on("message:video_note", (ctx) => this.intake(ctx, "video", { fileId: ctx.message.video_note.file_id }));

    this.bot.on("callback_query:data", (ctx) => this.handleButton(ctx));

    this.bot.on("message", (ctx) => ctx.reply("scriba handles text, voice, images, and video for now."));
  }

  private async intake(ctx: any, kind: JotKind, src: { rawText?: string; fileId?: string }): Promise<void> {
    // Ack receipt with a reaction (✍ = received/awaiting) — best-effort, intake
    // proceeds if it fails. Swapped to 👌/😱 by react() once processing settles.
    await ctx.react("✍").catch(() => {});
    const epochMs = ctx.message.date * 1000;
    const id = makeJotId();
    const date = plainDate(epochMs);
    const time = plainTime(epochMs);
    log.info({ id, kind, date, time, hasFile: !!src.fileId, hasText: !!src.rawText }, "jot received");
    const notePath = await this.obsidian.ensureDailyNote(date);
    await this.obsidian.appendJournalLine(date, placeholderLine(time, id));
    log.debug({ id, notePath }, "placeholder line written");

    const now = Date.now();
    const jot: Jot = {
      id, kind, note_path: notePath, anchor: id, time,
      raw_text: src.rawText ?? null, transcript: null, asset_path: null,
      file_id: src.fileId ?? null, status: "pending", attempts: 0, error: null,
      received_at: epochMs, updated_at: now,
    };
    await this.repo.insertJot(jot);
    await this.repo.mapMessage(ctx.message.message_id, id);
    this.queue.add(id);
    log.debug({ id }, "jot queued for flush");
  }

  private async handleEdit(ctx: any): Promise<void> {
    const jotId = await this.repo.jotForMessage(ctx.message.reply_to_message.message_id);
    if (!jotId) return void ctx.reply("Can't find that jot to edit.");
    const jot = await this.repo.getJot(jotId);
    if (!jot) return void ctx.reply("Jot not found.");
    const instruction: string = ctx.message.text;

    // Editable only once a line exists (done or abandoned); otherwise it still needs
    // processing, so queue the edit and let onJotDone apply it after.
    const editable = jot.status === "done" || jot.status === "abandoned";
    if (!editable) {
      log.info({ jotId, status: jot.status }, "edit queued (jot still processing)");
      await this.repo.queueEdit(jotId, instruction);
      return void ctx.reply("⏳ still processing — I'll apply that edit once it's done.");
    }
    log.info({ jotId, instruction }, "applying edit");
    await ctx.reply(await this.applyEdits(jot, [instruction]));
  }

  /** Apply one or more edit instructions to a jot's line, merged into a single write
   *  (and a single agent call for the freeform ones). Returns a short status. */
  private async applyEdits(jot: Jot, instructions: string[]): Promise<string> {
    const note = await this.obsidian.readNote(jot.note_path);
    if (instructions.some((i) => i.trim().toLowerCase() === "delete")) {
      const out = deleteAnchorLine(note, jot.anchor);
      if (out) await this.obsidian.writeNote(jot.note_path, out);
      await this.repo.updateJot(jot.id, { status: "done" });
      return "🗑️ deleted";
    }
    const line = anchorLine(note, jot.anchor);
    if (!line) return "Couldn't find that line in the note.";

    let text = this.lineText(line, jot);
    const freeform: string[] = [];
    for (const ins of instructions) {
      const lit = parseLiteralEdit(ins);
      if (lit) text = text.replaceAll(lit.old, lit.new); // deterministic, free
      else freeform.push(ins);
    }
    // Merge all freeform edits into one agent call rather than one per instruction.
    if (freeform.length) text = await this.enricher.editText(text, freeform.join("; then "));

    const out = replaceAnchorLine(note, jot.anchor, journalLine(jot.time, text, jot.anchor));
    if (out) await this.obsidian.writeNote(jot.note_path, out);
    return "✏️ updated";
  }

  /** Strip the `- _time ::_ ` prefix and ` ^anchor` suffix to get just the content. */
  private lineText(line: string, jot: Jot): string {
    return line
      .replace(new RegExp(`^- _${jot.time} ::_ `), "")
      .replace(new RegExp(`\\s*\\^${jot.anchor}\\s*$`), "");
  }

  private async handleButton(ctx: any): Promise<void> {
    const [ns, ...rest] = String(ctx.callbackQuery.data).split(":");
    log.debug({ data: ctx.callbackQuery.data }, "button pressed");
    if (ns === "rt") return this.handleRetry(ctx, rest[0]);
    if (ns === "lk") return this.handleLink(ctx, rest[0], rest[1]);
    if (ns === RATING_NS) return this.rating.handleTap(ctx, rest[0], rest[1]);
    await ctx.answerCallbackQuery();
  }

  private async handleRetry(ctx: any, jotId?: string): Promise<void> {
    if (!jotId || !(await this.repo.getJot(jotId))) return void ctx.answerCallbackQuery({ text: "gone" });
    log.info({ jotId }, "manual retry requested");
    await this.repo.updateJot(jotId, { status: "pending", attempts: 0, error: null });
    this.queue.add(jotId);
    await ctx.answerCallbackQuery({ text: "retrying" });
    await ctx.editMessageText("🔄 retrying…");
  }

  private async handleLink(ctx: any, verd?: string, pid?: string): Promise<void> {
    if (!pid) return void ctx.answerCallbackQuery();
    const rec = await this.repo.takePendingLink(pid);
    if (!rec) return void ctx.answerCallbackQuery({ text: "expired" });

    if (verd === "n") {
      log.info({ surface: rec.surface, note: rec.note }, "link rejected — learning it");
      await this.repo.reject(rec.surface, rec.note);
      await ctx.answerCallbackQuery({ text: "won't link again" });
      return void ctx.editMessageText(`✋ "${rec.surface}" ✗ [[${rec.note}]] (won't ask again)`);
    }

    let applied = false;
    const jot = await this.repo.getJot(rec.jot_id);
    if (jot) {
      const note = await this.obsidian.readNote(jot.note_path);
      const line = anchorLine(note, jot.anchor);
      const linked = line?.replace(rec.surface, `[[${rec.note}|${rec.surface}]]`);
      if (line && linked && linked !== line) {
        const out = replaceAnchorLine(note, jot.anchor, linked);
        if (out) { await this.obsidian.writeNote(jot.note_path, out); applied = true; }
      }
    }
    log.info({ surface: rec.surface, note: rec.note, applied }, "link confirmation handled");
    await ctx.answerCallbackQuery({ text: applied ? "linked" : "no change" });
    await ctx.editMessageText(applied ? `🔗 "${rec.surface}" → [[${rec.note}]]` : `"${rec.surface}": nothing to link`);
  }
}
