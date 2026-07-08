import { extname } from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { commands, type Deps } from "./commands/index.ts";
import { config } from "./config.ts";
import {
	anchorLine,
	deleteAnchorLine,
	entitiesToMarkdown,
	isBlank,
	journalLine,
	makeJotId,
	parseLiteralEdit,
	placeholderLine,
	replaceAnchorLine,
	stripJournalLine,
} from "./core.ts";
import type { Jot, JotKind, Repository } from "./db.ts";
import {
	HABITS_NS,
	HabitsCommand,
	parseHabitRef,
} from "./flows/habits/index.ts";
import { RATING_NS, RatingCommand } from "./flows/rating.ts";
import { logger } from "./log.ts";
import type {
	BotServices,
	DownloadedFile,
	JotProcessor,
} from "./runtime/processor.ts";
import type { FlushQueue } from "./runtime/queue.ts";
import type { Enricher } from "./services/enrich.ts";
import type { LinkIndex } from "./services/links.ts";
import type { ObsidianClient } from "./services/obsidian.ts";
import type { TranscriberSwitch } from "./services/transcribe.ts";
import { plainDate, plainTime } from "./time.ts";

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
	private queue!: FlushQueue;
	private rating: RatingCommand;
	private habits: HabitsCommand;
	private processor!: JotProcessor;
	// jotId -> the live status message we edit in place through the jot's lifecycle.
	// ponytail: in-memory. On restart the map is empty and status() just posts a fresh
	// message; nothing is lost. Persist it only if that ever proves annoying.
	private statusMsgs = new Map<string, number>();

	constructor(
		private repo: Repository,
		private obsidian: ObsidianClient,
		private enricher: Enricher,
		private transcriber: TranscriberSwitch,
		private links: LinkIndex,
		private version: string,
		private sha: string,
		private startedAt: number,
	) {
		this.bot = new Bot(config.telegram.token);
		this.rating = new RatingCommand(this.bot, repo, obsidian);
		this.habits = new HabitsCommand(this.bot, obsidian);
		this.registerHandlers();
	}

	/** Break the wiring cycle: queue + processor are created after this bot (which they need). */
	setQueue(queue: FlushQueue): void {
		this.queue = queue;
	}
	setProcessor(processor: JotProcessor): void {
		this.processor = processor;
	}

	/** Assemble what the admin commands act on. */
	private deps(): Deps {
		return {
			repo: this.repo,
			queue: this.queue,
			processor: this.processor,
			transcriber: this.transcriber,
			links: this.links,
			version: this.version,
			sha: this.sha,
			startedAt: this.startedAt,
		};
	}

	/** Start long polling. Returns immediately; polling runs in the background. */
	async start(): Promise<void> {
		// Populate the `/` command menu Telegram shows in the compose box.
		await this.bot.api
			.setMyCommands([
				{ command: "start", description: "What scriba does" },
				{
					command: "rate",
					description: "Rate a day 1–10 (today, or /rate YYYY-MM-DD)",
				},
				{
					command: "habits",
					description: "Review habits (yesterday, or /habits YYYY-MM-DD)",
				},
				{
					command: "delete",
					description: "Reply to a journal message with /delete to remove it",
				},
				...commands.map((c) => ({
					command: c.name,
					description: c.description,
				})),
			])
			.catch((e) => log.warn({ err: e }, "setMyCommands failed"));
		void this.bot.start({
			allowed_updates: ["message", "edited_message", "callback_query"],
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
		await this.bot.api.sendMessage(config.telegram.allowedUserId, text);
	}

	/** Nightly rating prompt (the scheduler calls this). Delegates to the rating command. */
	async promptRating(date: string): Promise<void> {
		await this.rating.prompt(date);
	}

	/** Nightly habit review prompt (the scheduler calls this). Delegates to the habits command. */
	async promptHabits(date: string): Promise<void> {
		await this.habits.prompt(date);
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
		await this.bot.api.sendMessage(
			config.telegram.allowedUserId,
			`Link "${surface}" → [[${note}]]?`,
			{ reply_markup: kb },
		);
	}

	/** Create-or-edit the one live status message for a jot. First call sends it and
	 *  remembers the message id; later calls edit that same message in place, so the
	 *  chat reads as a clean audit trail instead of a stream of notifications.
	 *  `retry: true` attaches a force-retry button; otherwise any button is cleared. */
	async status(
		jotId: string,
		html: string,
		opts?: { retry?: boolean },
	): Promise<void> {
		const reply_markup = opts?.retry
			? new InlineKeyboard().text("🔄 Retry", `rt:${jotId}`)
			: new InlineKeyboard();
		const chat = config.telegram.allowedUserId;
		const existing = this.statusMsgs.get(jotId);
		if (existing) {
			try {
				await this.bot.api.editMessageText(chat, existing, html, {
					parse_mode: "HTML",
					reply_markup,
				});
				log.debug({ jotId, messageId: existing }, "status edited");
				return;
			} catch (err) {
				log.warn(
					{ jotId, messageId: existing, err },
					"status edit failed — sending a fresh one",
				);
			}
		}
		const msg = await this.bot.api.sendMessage(chat, html, {
			parse_mode: "HTML",
			reply_markup,
		});
		this.statusMsgs.set(jotId, msg.message_id);
		log.debug({ jotId, messageId: msg.message_id }, "status message sent");
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
		await this.bot.api
			.setMessageReaction(config.telegram.allowedUserId, messageId, [
				{ type: "emoji", emoji },
			])
			.catch(() => {});
	}

	/** Best-effort "typing…" chat action. Telegram clears it after ~5s on its own. */
	async typing(): Promise<void> {
		await this.bot.api
			.sendChatAction(config.telegram.allowedUserId, "typing")
			.catch(() => {});
	}

	async downloadFile(fileId: string): Promise<DownloadedFile> {
		const file = await this.bot.api.getFile(fileId);
		if (!file.file_path) throw new Error(`no file_path for ${fileId}`);
		const res = await fetch(
			`https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`,
		);
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
		log.info(
			{ jotId, count: edits.length },
			"applying edits queued during processing",
		);
		await this.applyEdits(jot, edits);
		await this.notify(
			`✏️ Applied ${edits.length} queued edit${edits.length > 1 ? "s" : ""}.`,
		);
	}

	// --- handlers ---
	private registerHandlers(): void {
		// Surface handler errors back to the user instead of dying silently.
		this.bot.catch(async (err) => {
			const msg =
				err.error instanceof Error ? err.error.message : String(err.error);
			log.error({ err: err.error }, "bot handler error");
			await err.ctx.reply(`⚠️ Couldn't save that: ${msg}`).catch(() => {});
		});

		// single-user allowlist — everyone else is ignored
		this.bot.use(async (ctx, next) => {
			if (ctx.from?.id === config.telegram.allowedUserId) await next();
		});

		this.bot.command("start", (ctx) =>
			ctx.reply(
				"scriba ready. Send text or a voice note to journal. /help for admin commands.",
			),
		);
		this.rating.register();
		this.habits.register();

		// Admin commands (single-user, so the allowlist above is the only auth needed).
		for (const cmd of commands) {
			this.bot.command(cmd.name, async (ctx) => {
				const out = await cmd.run(ctx, String(ctx.match ?? ""), this.deps());
				if (typeof out === "string") await ctx.reply(out);
			});
		}

		// Reply to a jot's message with /delete to remove its journal line. This is the
		// explicit counterpart to clearing the message text (an actual Telegram delete is
		// never delivered to bots, so there's nothing to hook).
		this.bot.command("delete", (ctx) => this.handleDeleteCommand(ctx));

		this.bot.on("message:text", async (ctx) => {
			if (ctx.message.text.startsWith("/")) return;
			if (ctx.message.reply_to_message) {
				// A reply to a habit value question routes to the habit flow, not a jot edit.
				if (parseHabitRef(ctx.message.reply_to_message.text ?? ""))
					return this.habits.handleReply(ctx);
				return this.handleEdit(ctx);
			}
			const markdown = entitiesToMarkdown(
				ctx.message.text,
				ctx.message.entities,
			);
			await this.intake(ctx, "text", { rawText: markdown });
		});

		this.bot.on("message:voice", (ctx) =>
			this.intake(ctx, "audio", { fileId: ctx.message.voice.file_id }),
		);
		this.bot.on("message:audio", (ctx) =>
			this.intake(ctx, "audio", { fileId: ctx.message.audio.file_id }),
		);

		// Image/video are attachments: saved and embedded, caption kept, not transcribed.
		this.bot.on("message:photo", (ctx) => {
			const markdown = entitiesToMarkdown(
				ctx.message.caption ?? "",
				ctx.message.caption_entities,
			);
			this.intake(ctx, "image", {
				fileId: ctx.message.photo.at(-1)!.file_id,
				rawText: markdown,
			});
		});
		this.bot.on("message:video", (ctx) => {
			const markdown = entitiesToMarkdown(
				ctx.message.caption ?? "",
				ctx.message.caption_entities,
			);
			this.intake(ctx, "video", {
				fileId: ctx.message.video.file_id,
				rawText: markdown,
			});
		});
		this.bot.on("message:video_note", (ctx) =>
			this.intake(ctx, "video", { fileId: ctx.message.video_note.file_id }),
		);

		// Edited text messages — edit the jot in place if already processed,
		// otherwise queue the edit for when processing finishes.
		this.bot.on("edited_message:text", (ctx) => {
			if (ctx.editedMessage.text.startsWith("/")) return;
			return this.applyMessageEdit(
				ctx,
				entitiesToMarkdown(ctx.editedMessage.text, ctx.editedMessage.entities),
				"",
			);
		});

		// Edited captions on media — treat same as text edits for the jot text.
		this.bot.on("edited_message:caption", (ctx) =>
			this.applyMessageEdit(
				ctx,
				entitiesToMarkdown(
					ctx.editedMessage.caption ?? "",
					ctx.editedMessage.caption_entities,
				),
				"caption ",
			),
		);

		this.bot.on("callback_query:data", (ctx) => this.handleButton(ctx));

		this.bot.on("message", (ctx) =>
			ctx.reply("scriba handles text, voice, images, and video for now."),
		);
	}

	// Edit an existing jot in place if it's already processed, otherwise queue
	// the edit for when processing finishes. Clearing the message to empty/whitespace
	// is the delete gesture (Telegram never delivers an actual message delete), so a
	// blank edit removes the journal line instead of replacing it.
	// label ("" | "caption ") tunes logs.
	private async applyMessageEdit(
		ctx: any,
		markdown: string,
		label: string,
	): Promise<void> {
		const jotId = await this.repo.jotForMessage(ctx.editedMessage.message_id);
		if (!jotId) return;
		const jot = await this.repo.getJot(jotId);
		if (!jot) return;
		const blank = isBlank(markdown);
		const editable = jot.status === "done" || jot.status === "abandoned";
		if (!editable) {
			// "delete" is the instruction applyEdits recognises when onJotDone drains the
			// queue, so an in-flight jot is deleted the moment its line is first written.
			log.info(
				{ jotId, status: jot.status, blank },
				`${label}${blank ? "delete" : "edit"} queued (jot still processing)`,
			);
			await this.repo.queueEdit(jotId, blank ? "delete" : markdown);
			return void ctx.reply(
				blank
					? "⏳ still processing — I'll remove it once it's done."
					: "⏳ still processing — I'll apply that edit once it's done.",
			);
		}
		if (blank) {
			log.info({ jotId }, `${label}cleared — removing journal line`);
			await ctx.reply("🗑️ got it — removing…");
			return void ctx.reply(await this.deleteJot(jot));
		}
		log.info(
			{ jotId, text: markdown },
			`applying ${label}edit to processed jot`,
		);
		await ctx.reply("✍️ got your edit — applying…");
		await ctx.reply(await this.replaceJotText(jot, markdown));
	}

	private async intake(
		ctx: any,
		kind: JotKind,
		src: { rawText?: string; fileId?: string },
	): Promise<void> {
		// Ack receipt with a reaction (✍ = received/awaiting) — best-effort, intake
		// proceeds if it fails. Swapped to 👌/😱 by react() once processing settles.
		await ctx.react("✍").catch(() => {});
		const epochMs = ctx.message.date * 1000;
		const id = makeJotId();
		const date = plainDate(epochMs);
		const time = plainTime(epochMs);
		log.info(
			{ id, kind, date, time, hasFile: !!src.fileId, hasText: !!src.rawText },
			"jot received",
		);
		const notePath = await this.obsidian.ensureDailyNote(date);
		await this.obsidian.appendJournalLine(date, placeholderLine(time, id));
		log.debug({ id, notePath }, "placeholder line written");

		const now = Date.now();
		const jot: Jot = {
			id,
			kind,
			note_path: notePath,
			anchor: id,
			time,
			raw_text: src.rawText ?? null,
			transcript: null,
			asset_path: null,
			file_id: src.fileId ?? null,
			status: "pending",
			attempts: 0,
			error: null,
			received_at: epochMs,
			updated_at: now,
		};
		await this.repo.insertJot(jot);
		await this.repo.mapMessage(ctx.message.message_id, id);
		this.queue.add(id);
		log.debug({ id }, "jot queued for flush");
	}

	private async handleEdit(ctx: any): Promise<void> {
		const jotId = await this.repo.jotForMessage(
			ctx.message.reply_to_message.message_id,
		);
		if (!jotId) return void ctx.reply("Can't find that jot to edit.");
		const jot = await this.repo.getJot(jotId);
		if (!jot) return void ctx.reply("Jot not found.");
		const instruction: string = ctx.message.text;

		// Editable only once a line exists (done or abandoned); otherwise it still needs
		// processing, so queue the edit and let onJotDone apply it after.
		const editable = jot.status === "done" || jot.status === "abandoned";
		if (!editable) {
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
		await ctx.reply(await this.applyEdits(jot, [instruction]));
	}

	/** Apply one or more edit instructions to a jot's line, merged into a single write
	 *  (and a single agent call for the freeform ones). Returns a short status. */
	private async applyEdits(jot: Jot, instructions: string[]): Promise<string> {
		const note = await this.obsidian.readNote(jot.note_path);
		if (instructions.some((i) => i.trim().toLowerCase() === "delete")) {
			const out = deleteAnchorLine(note, jot.anchor);
			if (out) await this.obsidian.writeNote(jot.note_path, out);
			await this.repo.markDeleted(jot.id);
			return "🗑️ removed that from your journal.";
		}
		const line = anchorLine(note, jot.anchor);
		if (!line) return "Couldn't find that line in the note.";

		let text = stripJournalLine(line, jot.time, jot.anchor);
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

		const out = replaceAnchorLine(
			note,
			jot.anchor,
			journalLine(jot.time, text, jot.anchor),
		);
		if (out) await this.obsidian.writeNote(jot.note_path, out);
		return "✏️ updated";
	}

	/** Replace a jot's entire text content (for edited messages, not instructions). */
	private async replaceJotText(jot: Jot, newText: string): Promise<string> {
		const note = await this.obsidian.readNote(jot.note_path);
		const out = replaceAnchorLine(
			note,
			jot.anchor,
			journalLine(jot.time, newText, jot.anchor),
		);
		if (!out) return "Couldn't find that line in the note.";
		await this.obsidian.writeNote(jot.note_path, out);
		return "✏️ updated";
	}

	/** Remove a jot's line from its daily note and mark it deleted (a terminal state, so a
	 *  retry sweep never resurrects it). Shared by the blank-edit path and /delete. */
	private async deleteJot(jot: Jot): Promise<string> {
		const note = await this.obsidian.readNote(jot.note_path);
		const out = deleteAnchorLine(note, jot.anchor);
		if (out === null) {
			// Line already gone (double delete, or removed by hand in Obsidian). Still mark
			// it deleted so the record matches reality — the user's intent is satisfied.
			log.warn(
				{ jotId: jot.id, anchor: jot.anchor },
				"delete: anchored line not found — marking deleted anyway",
			);
			await this.repo.markDeleted(jot.id);
			return "🗑️ removed that from your journal.";
		}
		await this.obsidian.writeNote(jot.note_path, out);
		await this.repo.markDeleted(jot.id);
		log.info({ jotId: jot.id }, "journal line deleted");
		return "🗑️ removed that from your journal.";
	}

	/** /delete: reply to a jot's message to remove its journal line. Mirrors the reply-edit
	 *  flow — queues the delete if the jot is still processing. */
	private async handleDeleteCommand(ctx: any): Promise<void> {
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
		const editable = jot.status === "done" || jot.status === "abandoned";
		if (!editable) {
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
		await ctx.reply(await this.deleteJot(jot));
	}

	private async handleButton(ctx: any): Promise<void> {
		const [ns, ...rest] = String(ctx.callbackQuery.data).split(":");
		log.debug({ data: ctx.callbackQuery.data }, "button pressed");
		if (ns === "rt") return this.handleRetry(ctx, rest[0]);
		if (ns === "lk") return this.handleLink(ctx, rest[0], rest[1]);
		if (ns === RATING_NS) return this.rating.handleTap(ctx, rest[0], rest[1]);
		if (ns === HABITS_NS)
			return this.habits.handleTap(ctx, rest[0], rest[1], rest[2]);
		await ctx.answerCallbackQuery();
	}

	private async handleRetry(ctx: any, jotId?: string): Promise<void> {
		if (!jotId || !(await this.repo.getJot(jotId)))
			return void ctx.answerCallbackQuery({ text: "gone" });
		log.info({ jotId }, "manual retry requested");
		await this.repo.resetForRetry(jotId);
		this.queue.add(jotId);
		await ctx.answerCallbackQuery({ text: "retrying" });
		await ctx.editMessageText("🔄 retrying…");
	}

	private async handleLink(
		ctx: any,
		verd?: string,
		pid?: string,
	): Promise<void> {
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

		let applied = false;
		const jot = await this.repo.getJot(rec.jot_id);
		if (jot) {
			const note = await this.obsidian.readNote(jot.note_path);
			const line = anchorLine(note, jot.anchor);
			const linked = line?.replace(
				rec.surface,
				`[[${rec.note}|${rec.surface}]]`,
			);
			if (line && linked && linked !== line) {
				const out = replaceAnchorLine(note, jot.anchor, linked);
				if (out) {
					await this.obsidian.writeNote(jot.note_path, out);
					applied = true;
				}
			}
		}
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
