import { Bot, InlineKeyboard } from "grammy";
import { extname } from "node:path";
import { fetch } from "undici";
import { config } from "./config.ts";
import type { Repository, Jot, JotKind } from "./db.ts";
import type { ObsidianClient } from "./obsidian.ts";
import type { Enricher } from "./enrich.ts";
import type { FlushQueue } from "./queue.ts";
import type { BotServices, DownloadedFile } from "./processor.ts";
import { makeJotId, placeholderLine, journalLine, anchorLine, replaceAnchorLine, deleteAnchorLine, parseLiteralEdit } from "./core.ts";
import { plainDate, plainTime } from "./time.ts";

const MIME: Record<string, string> = {
  oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

/** All Telegram wiring lives here. Long polling — no inbound webhook. Implements
 *  BotServices so the processor can notify, ask link questions, download files,
 *  and trigger queued edits once a jot finishes. */
export class ScribaBot implements BotServices {
  private bot: Bot;
  private queue!: FlushQueue;

  constructor(
    private repo: Repository,
    private obsidian: ObsidianClient,
    private enricher: Enricher,
  ) {
    this.bot = new Bot(config.telegram.token);
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
      onStart: (me) => console.log(`scriba polling as @${me.username}`),
    });
  }
  async stop(): Promise<void> {
    await this.bot.stop();
  }

  // --- BotServices ---
  async notify(text: string): Promise<void> {
    await this.bot.api.sendMessage(config.telegram.allowedUserId, text);
  }

  async askLink(pendingId: string, surface: string, note: string): Promise<void> {
    const kb = new InlineKeyboard().text("Yes", `lk:y:${pendingId}`).text("No", `lk:n:${pendingId}`);
    await this.bot.api.sendMessage(config.telegram.allowedUserId, `Link "${surface}" → [[${note}]]?`, { reply_markup: kb });
  }

  async askRetry(jotId: string, text: string): Promise<void> {
    const kb = new InlineKeyboard().text("🔄 Retry", `rt:${jotId}`);
    await this.bot.api.sendMessage(config.telegram.allowedUserId, text, { reply_markup: kb });
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error(`no file_path for ${fileId}`);
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ext = (extname(file.file_path).slice(1) || "bin").toLowerCase();
    return { bytes, ext, mime: MIME[ext] ?? "application/octet-stream" };
  }

  /** Apply edits that were queued while this jot was still processing. */
  async onJotDone(jotId: string): Promise<void> {
    const edits = await this.repo.takeQueuedEdits(jotId);
    if (!edits.length) return;
    const jot = await this.repo.getJot(jotId);
    if (!jot) return;
    await this.applyEdits(jot, edits);
    await this.notify(`✏️ Applied ${edits.length} queued edit${edits.length > 1 ? "s" : ""}.`);
  }

  // --- handlers ---
  private registerHandlers(): void {
    // Surface handler errors back to the user instead of dying silently.
    this.bot.catch(async (err) => {
      const msg = err.error instanceof Error ? err.error.message : String(err.error);
      console.error("bot handler error:", err.error);
      await err.ctx.reply(`⚠️ Couldn't save that: ${msg}`).catch(() => {});
    });

    // single-user allowlist — everyone else is ignored
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id === config.telegram.allowedUserId) await next();
    });

    this.bot.command("start", (ctx) => ctx.reply("scriba ready. Send text or a voice note to journal."));

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
    // Acknowledge receipt immediately (reactions don't clutter the chat). If this fails
    // the intake still proceeds — it's only feedback.
    await ctx.react("👀").catch(() => {});
    const epochMs = ctx.message.date * 1000;
    const id = makeJotId();
    const date = plainDate(epochMs);
    const time = plainTime(epochMs);
    const notePath = await this.obsidian.ensureDailyNote(date);
    await this.obsidian.appendJournalLine(date, placeholderLine(time, id));

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
      await this.repo.queueEdit(jotId, instruction);
      return void ctx.reply("⏳ still processing — I'll apply that edit once it's done.");
    }
    await ctx.reply(await this.applyEdits(jot, [instruction]));
  }

  /** Apply one or more edit instructions to a jot's line, merged into a single write
   *  (and a single agent call for the freeform ones). Returns a short status. */
  private async applyEdits(jot: Jot, instructions: string[]): Promise<string> {
    const note = await this.obsidian.readNote(jot.note_path); // live read
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
    if (ns === "rt") return this.handleRetry(ctx, rest[0]);
    if (ns === "lk") return this.handleLink(ctx, rest[0], rest[1]);
    await ctx.answerCallbackQuery();
  }

  private async handleRetry(ctx: any, jotId?: string): Promise<void> {
    if (!jotId || !(await this.repo.getJot(jotId))) return void ctx.answerCallbackQuery({ text: "gone" });
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
    await ctx.answerCallbackQuery({ text: applied ? "linked" : "no change" });
    await ctx.editMessageText(applied ? `🔗 "${rec.surface}" → [[${rec.note}]]` : `"${rec.surface}": nothing to link`);
  }
}
