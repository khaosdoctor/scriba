import { extname } from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { commands, type Deps } from "./commands/index.ts";
import { UNREJECT_NS } from "./commands/unreject.ts";
import { config } from "./config.ts";
import {
	anchorLine,
	deleteAnchorLine,
	distinctSurfaces,
	entitiesToMarkdown,
	formatJotDetail,
	isBlank,
	isEditableJot,
	jotPreview,
	journalLine,
	makeJotId,
	parseLiteralEdit,
	placeholderLine,
	replaceAnchorLine,
	STATUS_ICON,
	stripJournalLine,
	withinSquashWindow,
} from "./core.ts";
import type { Jot, JotKind, Repository } from "./db.ts";
import {
	HABITS_NS,
	HabitsCommand,
	parseHabitRef,
} from "./flows/habits/index.ts";
import { RATING_NS, RatingCommand } from "./flows/rating.ts";
import { REPROCESS_NS, ReprocessCommand } from "./flows/reprocess.ts";
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
	private reprocess: ReprocessCommand;
	private processor!: JotProcessor;
	// jotId -> the live status message we edit in place through the jot's lifecycle.
	// ponytail: in-memory. On restart the map is empty and status() just posts a fresh
	// message; nothing is lost. Persist it only if that ever proves annoying.
	private statusMsgs = new Map<string, number>();
	// Rejected-links menu page size (rows per page).
	private static readonly REJECT_PAGE = 8;
	// Message id of the last root menu, so opening a fresh /menu retires the old one
	// instead of leaving stale, still-tappable keyboards piling up in the chat.
	private lastMenuMsgId?: number;

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
		this.reprocess = new ReprocessCommand(this.bot, repo);
		this.registerHandlers();
	}

	/** Break the wiring cycle: queue + processor are created after this bot (which they need). */
	setQueue(queue: FlushQueue): void {
		this.queue = queue;
		this.reprocess.setQueue(queue);
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
				{ command: "menu", description: "Open the interactive control menu" },
				{
					command: "rate",
					description: "Rate a day 1–10 (today, or /rate YYYY-MM-DD)",
				},
				{
					command: "habits",
					description: "Review habits (yesterday, or /habits YYYY-MM-DD)",
				},
				{
					command: "reprocess",
					description: "Reprocess jots — a day, a date range, or one jot",
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
		// Map the bot's status message to the jot too, so a reply to it edits the jot
		// just like a reply to the original message (e.g. the transcribed audio note).
		await this.repo.mapMessage(msg.message_id, jotId);
		log.debug({ jotId, messageId: msg.message_id }, "status message sent");
	}

	/** Delete a jot's live status message, if it has one. Best-effort: used on a squash
	 *  to collapse any stray per-follower message into the leader's single confirmation. */
	async deleteStatus(jotId: string): Promise<void> {
		const messageId = this.statusMsgs.get(jotId);
		if (!messageId) return;
		this.statusMsgs.delete(jotId);
		await this.repo.unmapMessage(messageId); // no stale reply-map to a gone message
		try {
			await this.bot.api.deleteMessage(
				config.telegram.allowedUserId,
				messageId,
			);
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
		const edits = await this.repo.queuedEdits(jotId);
		if (!edits.length) return;
		const jot = await this.repo.getJot(jotId);
		if (!jot) return;
		log.info(
			{ jotId, count: edits.length },
			"applying edits queued during processing",
		);
		await this.applyEdits(jot, edits);
		await this.repo.clearQueuedEdits(jotId); // clear only after apply succeeds, so a throw doesn't lose them
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
			// A failed menu/button tap: stop the button's spinner with a toast and stop here.
			// Otherwise it spins forever and bot.catch posts jot-intake copy that doesn't fit.
			if (err.ctx.callbackQuery) {
				await err.ctx
					.answerCallbackQuery({ text: `⚠️ ${msg}`.slice(0, 200) })
					.catch(() => {});
				return;
			}
			// If the failing message already has a jot row (intake persists it before the
			// network write that usually throws here), offer a retry button wired to the same
			// `rt:` handler the give-up path uses. No jot → plain error (e.g. a command failure).
			const messageId = err.ctx.message?.message_id;
			const jotId = messageId
				? await this.repo.jotForMessage(messageId).catch(() => undefined)
				: undefined;
			const reply_markup = jotId
				? new InlineKeyboard().text("🔄 Retry", `rt:${jotId}`)
				: undefined;
			await err.ctx
				.reply(`⚠️ Couldn't save that: ${msg}`, { reply_markup })
				.catch(() => {});
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
		this.reprocess.register();

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

		// Interactive control menu — an entry point layered over the slash commands, not a
		// replacement. Every leaf reuses an existing command or flow (see handleMenu).
		this.bot.command("menu", (ctx) => this.sendMenu(ctx));

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
		// `return` the promise so a rejection reaches bot.catch (a fire-and-forget arrow
		// would swallow it and leave the ✍ reaction stuck forever).
		this.bot.on("message:photo", (ctx) =>
			this.intakeMedia(ctx, "image", ctx.message.photo.at(-1)!.file_id),
		);
		this.bot.on("message:video", (ctx) =>
			this.intakeMedia(ctx, "video", ctx.message.video.file_id),
		);
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
	private async applyMessageEdit(ctx: any, markdown: string): Promise<void> {
		const jotId = await this.repo.jotForMessage(ctx.editedMessage.message_id);
		if (!jotId) return;
		const jot = await this.repo.getJot(jotId);
		if (!jot) return;
		const blank = isBlank(markdown);
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
		if (blank) {
			log.info({ jotId }, "edited message cleared — removing journal line");
			await ctx.reply("🗑️ got it — removing…");
			return void ctx.reply(await this.deleteJot(jot));
		}
		log.info({ jotId, text: markdown }, "applying edit to processed jot");
		await ctx.reply("✍️ got your edit — applying…");
		await ctx.reply(await this.replaceJotText(jot, markdown));
	}

	/** Attachment intake (image/video): keep the caption as display text, save + embed the
	 *  file. Returns the intake promise so a rejection reaches bot.catch. */
	private intakeMedia(ctx: any, kind: JotKind, fileId: string): Promise<void> {
		const markdown = entitiesToMarkdown(
			ctx.message.caption ?? "",
			ctx.message.caption_entities,
		);
		return this.intake(ctx, kind, { fileId, rawText: markdown });
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
		// dailyPath is pure (no REST call), so the row can be persisted even when Obsidian is
		// down. ensureDailyNote + the placeholder write happen after, and writeLine recreates
		// the note on flush, so a failed placeholder self-heals.
		const notePath = this.obsidian.dailyPath(date);

		// Squash a rapid burst: a text/voice jot arriving within the squash window of the
		// previous still-pending text/voice jot in this note folds into that jot's line —
		// it shares the leader's anchor and skips its own placeholder, so the processor
		// (which groups by anchor) enriches them into one line. Ordering never changes: the
		// leader's placeholder is already in place. Attach-only kinds never squash.
		let anchor = id;
		let squashed = false;
		if (kind === "text" || kind === "audio") {
			const prev = await this.repo.lastPendingEnrichableJot(notePath);
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

		const now = Date.now();
		const jot: Jot = {
			id,
			kind,
			note_path: notePath,
			anchor,
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
			await this.obsidian.appendJournalLine(date, placeholderLine(time, id));
			log.debug({ id, notePath }, "placeholder line written");
		}
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
		await ctx.reply(await this.applyEdits(jot, [instruction]));
	}

	/** Apply one or more edit instructions to a jot's line, merged into a single write
	 *  (and a single agent call for the freeform ones). Returns a short status. */
	private async applyEdits(jot: Jot, instructions: string[]): Promise<string> {
		// Delete short-circuits to deleteJot (which takes the note lock itself) BEFORE we
		// acquire it here — locking here and then calling deleteJot would deadlock on the path.
		if (instructions.some((i) => i.trim().toLowerCase() === "delete"))
			return this.deleteJot(jot);
		return this.obsidian.withNoteLock(jot.note_path, async () => {
			const note = await this.obsidian.readNote(jot.note_path);
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
		});
	}

	/** Replace a jot's entire text content (for edited messages, not instructions). */
	private async replaceJotText(jot: Jot, newText: string): Promise<string> {
		return this.obsidian.withNoteLock(jot.note_path, async () => {
			const note = await this.obsidian.readNote(jot.note_path);
			const out = replaceAnchorLine(
				note,
				jot.anchor,
				journalLine(jot.time, newText, jot.anchor),
			);
			if (!out) return "Couldn't find that line in the note.";
			await this.obsidian.writeNote(jot.note_path, out);
			return "✏️ updated";
		});
	}

	/** Remove a jot's line from its daily note and mark it deleted (a terminal state, so a
	 *  retry sweep never resurrects it). Shared by the blank-edit path and /delete. */
	private async deleteJot(jot: Jot): Promise<string> {
		const out = await this.obsidian.withNoteLock(jot.note_path, async () => {
			const note = await this.obsidian.readNote(jot.note_path);
			const removed = deleteAnchorLine(note, jot.anchor);
			if (removed !== null)
				await this.obsidian.writeNote(jot.note_path, removed);
			return removed;
		});
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
		await ctx.reply(await this.deleteJot(jot));
	}

	private async handleButton(ctx: any): Promise<void> {
		const [ns, ...rest] = String(ctx.callbackQuery.data).split(":");
		log.debug({ data: ctx.callbackQuery.data }, "button pressed");
		if (ns === "menu") return this.handleMenu(ctx, rest);
		if (ns === "rt") return this.handleRetry(ctx, rest[0]);
		if (ns === "lk") return this.handleLink(ctx, rest[0], rest[1]);
		if (ns === UNREJECT_NS) return this.handleUnreject(ctx, rest);
		if (ns === RATING_NS) return this.rating.handleTap(ctx, rest[0], rest[1]);
		if (ns === HABITS_NS)
			return this.habits.handleTap(ctx, rest[0], rest[1], rest[2]);
		if (ns === REPROCESS_NS) return this.reprocess.handleTap(ctx, rest);
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

	/** Interactive /unreject. `ur:s:<si>` shows the notes rejected for surface `si`;
	 *  `ur:p:<si>:<ni>` undoes that surface→note rejection. Indices are positions in the
	 *  deterministically ordered rejection list, re-derived on each tap so no state is
	 *  held between messages. A shifted index (rejection changed meanwhile) answers
	 *  "expired" rather than undoing the wrong pair. */
	private async handleUnreject(ctx: any, rest: string[]): Promise<void> {
		const [step, ...idx] = rest;
		const list = await this.repo.rejectionList();
		const surfaces = distinctSurfaces(list);
		const surface = surfaces[Number(idx[0])];
		if (surface === undefined) {
			log.warn({ step, idx }, "unreject: surface index out of range");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		const notes = list.filter((r) => r.surface === surface).map((r) => r.note);

		if (step === "s") {
			log.info({ surface, notes: notes.length }, "unreject: surface picked");
			const kb = new InlineKeyboard();
			notes.forEach((n, ni) => {
				kb.text(n, `${UNREJECT_NS}:p:${idx[0]}:${ni}`).row();
			});
			await ctx.answerCallbackQuery();
			return void ctx.editMessageText(`Unreject "${surface}" → which note?`, {
				reply_markup: kb,
			});
		}

		if (step === "p") {
			const note = notes[Number(idx[1])];
			if (note === undefined) {
				log.warn({ surface, idx }, "unreject: note index out of range");
				return void ctx.answerCallbackQuery({ text: "expired" });
			}
			const n = await this.repo.unreject(surface, note);
			log.info({ surface, note, removed: n }, "unreject via menu");
			await ctx.answerCallbackQuery({
				text: n ? "unrejected" : "already gone",
			});
			return void ctx.editMessageText(
				n
					? `↩️ "${surface}" may link to [[${note}]] again`
					: `no rejection for "${surface}" → [[${note}]]`,
			);
		}

		await ctx.answerCallbackQuery();
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

	// --- interactive menu (/menu) ---
	// A callback-driven control panel in the `menu:` namespace. Every leaf reuses an
	// existing command (via runCmd) or flow (rating/habits prompts, deleteJot, the edit
	// path), so the menu adds an entry point but no new business logic.

	/** /menu — send a fresh root menu. Later taps edit that message in place. */
	private async sendMenu(ctx: any): Promise<void> {
		log.info("menu opened");
		// Retire the previous menu so old, stale keyboards don't linger tappable in chat.
		if (this.lastMenuMsgId) {
			await ctx.api
				.deleteMessage(ctx.chat.id, this.lastMenuMsgId)
				.catch(() => {});
		}
		const sent = await ctx.reply("🗂 scriba control menu", {
			reply_markup: this.rootMenu(),
		});
		this.lastMenuMsgId = sent.message_id;
	}

	private rootMenu(): InlineKeyboard {
		return new InlineKeyboard()
			.text("📊 Rate today", "menu:rate")
			.text("🌱 Review habits", "menu:habits")
			.row()
			.text("🗒 Recent jots", "menu:jots")
			.row()
			.text("🔁 Reprocess", "menu:reprocess")
			.row()
			.text("📈 Stats", "menu:stats")
			.text("🩺 Status", "menu:status")
			.row()
			.text("⚠️ Failed queue", "menu:failed")
			.row()
			.text(`🎙 Transcriber: ${this.transcriber.mode}`, "menu:tx")
			.row()
			.text("🔗 Link rules", "menu:links")
			.text("🛠 Maintenance", "menu:maint")
			.row()
			.text("✖ Close", "menu:close");
	}

	private maintMenu(): InlineKeyboard {
		return new InlineKeyboard()
			.text("⚡ Flush", "menu:flush")
			.text("🧹 Sweep", "menu:sweep")
			.row()
			.text("🔧 Unstick", "menu:unstick")
			.text("🔄 Retry all", "menu:retryall")
			.row()
			.text("‹ Back", "menu:root");
	}

	/** Link-learning controls (rejections + stopwords) — kept off the crowded root. */
	private linksMenu(): InlineKeyboard {
		return new InlineKeyboard()
			.text("🚫 Rejected links", "menu:rejections")
			.row()
			.text("🔇 Stopwords", "menu:stopwords")
			.row()
			.text("‹ Back", "menu:root");
	}

	private backTo(target: string): InlineKeyboard {
		return new InlineKeyboard().text("‹ Back", target);
	}

	/** Run a string-returning admin command from a callback and hand back its text. */
	private async runCmd(ctx: any, name: string, arg = ""): Promise<string> {
		const cmd = commands.find((c) => c.name === name);
		if (!cmd) return `unknown command ${name}`;
		const out = await cmd.run(ctx, arg, this.deps());
		return typeof out === "string" ? out : "";
	}

	/** Dispatch a `menu:<action>[:<arg>]` callback. */
	private async handleMenu(ctx: any, rest: string[]): Promise<void> {
		const [action, arg] = rest;
		switch (action) {
			case "root":
				await ctx.answerCallbackQuery();
				return void ctx.editMessageText("🗂 scriba control menu", {
					reply_markup: this.rootMenu(),
				});
			case "rate":
				// New prompt message lands below; toast tells the user the tap registered.
				await ctx.answerCallbackQuery({
					text: "Opening rating prompt below ↓",
				});
				return this.rating.prompt(plainDate());
			case "habits":
				await ctx.answerCallbackQuery({
					text: "Opening habits review below ↓",
				});
				return this.habits.prompt(plainDate(Date.now() - 86_400_000));
			case "jots":
				return this.menuJots(ctx);
			case "reprocess":
				await ctx.answerCallbackQuery({
					text: "Opening reprocess menu below ↓",
				});
				return this.reprocess.promptRoot();
			case "jot":
				return this.menuJotDetail(ctx, arg);
			case "jr":
				return this.menuJotRetry(ctx, arg);
			case "jd":
				return this.menuJotDeleteConfirm(ctx, arg);
			case "jdy":
				return this.menuJotDelete(ctx, arg);
			case "je":
				return this.menuJotEdit(ctx, arg);
			case "stats":
				return this.menuStats(ctx, arg);
			case "status":
				return this.menuInfo(ctx, "status", "", "menu:root");
			case "failed":
				return this.menuFailed(ctx);
			case "tx":
				return this.menuToggleTranscriber(ctx);
			case "maint":
				await ctx.answerCallbackQuery();
				return void ctx.editMessageText("🛠 Maintenance", {
					reply_markup: this.maintMenu(),
				});
			case "links":
				await ctx.answerCallbackQuery();
				return void ctx.editMessageText("🔗 Link rules", {
					reply_markup: this.linksMenu(),
				});
			case "rejections":
				return this.menuRejections(ctx, arg);
			case "rj":
				return this.menuRejectDelete(ctx, arg);
			case "stopwords":
				return this.menuInfo(ctx, "stopword", "list", "menu:links");
			case "close":
				return this.menuClose(ctx);
			case "flush":
			case "sweep":
			case "unstick":
				return this.menuMaint(ctx, action);
			case "retryall":
				return this.menuRetryAllConfirm(ctx);
			case "retryally":
				return this.menuMaint(ctx, "retry", "all");
			default:
				log.warn({ action }, "unknown menu action");
				await ctx.answerCallbackQuery();
		}
	}

	/** Show a command's text output with a Back button (status, stats result). */
	private async menuInfo(
		ctx: any,
		name: string,
		arg: string,
		back: string,
	): Promise<void> {
		await ctx.answerCallbackQuery();
		const text = await this.runCmd(ctx, name, arg);
		await ctx.editMessageText(text, { reply_markup: this.backTo(back) });
	}

	/** Stats: first tap shows a range picker; a range tap shows that window. */
	private async menuStats(ctx: any, range?: string): Promise<void> {
		await ctx.answerCallbackQuery();
		if (!range) {
			const kb = new InlineKeyboard()
				.text("Today", "menu:stats:today")
				.text("Week", "menu:stats:week")
				.text("All", "menu:stats:all")
				.row()
				.text("‹ Back", "menu:root");
			return void ctx.editMessageText("📈 Stats range:", { reply_markup: kb });
		}
		const text = await this.runCmd(ctx, "stats", range);
		await ctx.editMessageText(text, {
			reply_markup: this.backTo("menu:stats"),
		});
	}

	/** Flip the transcriber to the other backend (persisted) and re-render the root. */
	private async menuToggleTranscriber(ctx: any): Promise<void> {
		const next = this.transcriber.mode === "local" ? "remote" : "local";
		log.info({ next }, "menu: toggling transcriber");
		const out = await this.runCmd(ctx, "transcriber", next);
		await ctx.answerCallbackQuery({ text: out.slice(0, 200) });
		await ctx.editMessageText("🗂 scriba control menu", {
			reply_markup: this.rootMenu(),
		});
	}

	/** Retry-all re-queues every failed jot (network + enrichment) — confirm first. */
	private async menuRetryAllConfirm(ctx: any): Promise<void> {
		log.info("menu: retry-all confirm");
		await ctx.answerCallbackQuery();
		const kb = new InlineKeyboard()
			.text("✅ Yes, retry all", "menu:retryally")
			.row()
			.text("‹ Cancel", "menu:maint");
		await ctx.editMessageText("Requeue every failed jot?", {
			reply_markup: kb,
		});
	}

	/** Rejected links as tappable rows — one tap undoes that rejection, then re-renders.
	 *  Rows index into the deterministically ordered rejection list by position (same
	 *  pattern as /unreject); a stale tap whose index no longer resolves answers "expired"
	 *  instead of undoing the wrong pair. Back cancels out without touching anything. */
	private async menuRejections(ctx: any, arg?: string): Promise<void> {
		await ctx.answerCallbackQuery();
		return this.renderRejections(ctx, Number(arg) || 0);
	}

	/** Build and show one page of the rejection list (assumes the query is already answered).
	 *  Rows carry the global list index so a tap resolves regardless of the current page;
	 *  page is clamped so a delete that empties the last page falls back to a valid one. */
	private async renderRejections(ctx: any, page = 0): Promise<void> {
		const PAGE = ScribaBot.REJECT_PAGE;
		const list = await this.repo.rejectionList();
		if (!list.length)
			return void ctx.editMessageText("No rejected links.", {
				reply_markup: this.backTo("menu:links"),
			});
		const pages = Math.ceil(list.length / PAGE);
		const p = Math.min(Math.max(page, 0), pages - 1);
		const kb = new InlineKeyboard();
		list.slice(p * PAGE, p * PAGE + PAGE).forEach((r, j) => {
			const gi = p * PAGE + j;
			kb.text(
				`🗑 "${r.surface}" ✗ ${r.note}`.slice(0, 60),
				`menu:rj:${gi}`,
			).row();
		});
		if (pages > 1) {
			if (p > 0) kb.text("‹ Prev", `menu:rejections:${p - 1}`);
			if (p < pages - 1) kb.text("Next ›", `menu:rejections:${p + 1}`);
			kb.row();
		}
		kb.text("‹ Back", "menu:links");
		const header =
			pages > 1
				? `🚫 Tap to undo a rejection (page ${p + 1}/${pages}):`
				: "🚫 Tap to undo a rejection:";
		await ctx.editMessageText(header, { reply_markup: kb });
	}

	/** Undo the rejection at global index `arg`, then re-render its page (shrunk). */
	private async menuRejectDelete(ctx: any, arg?: string): Promise<void> {
		const list = await this.repo.rejectionList();
		const gi = arg === undefined ? -1 : Number(arg);
		const r = list[gi];
		if (!r) {
			log.warn({ arg }, "menu: reject index out of range");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		const n = await this.repo.unreject(r.surface, r.note);
		log.info(
			{ surface: r.surface, note: r.note, removed: n },
			"unreject via menu",
		);
		await ctx.answerCallbackQuery({ text: n ? "unrejected" : "already gone" });
		return this.renderRejections(ctx, Math.floor(gi / ScribaBot.REJECT_PAGE));
	}

	/** Close the menu — the control panel is transient, not part of the journal. */
	private async menuClose(ctx: any): Promise<void> {
		log.info("menu closed");
		await ctx.answerCallbackQuery();
		this.lastMenuMsgId = undefined;
		try {
			await ctx.deleteMessage();
		} catch (e) {
			// Delete can fail (already gone, >48h old); leave a tidy closed state instead.
			log.warn({ err: e }, "menu close: delete failed, editing instead");
			await ctx.editMessageText("🗂 Menu closed.", { reply_markup: undefined });
		}
	}

	/** Run a no-arg maintenance command and show its result over the maintenance menu. */
	private async menuMaint(ctx: any, name: string, arg = ""): Promise<void> {
		log.info({ cmd: name, arg }, "menu: maintenance action");
		const out = await this.runCmd(ctx, name, arg);
		await ctx.answerCallbackQuery({ text: "done" });
		await ctx.editMessageText(out || "done", {
			reply_markup: this.maintMenu(),
		});
	}

	/** The jots browser: recent jots as tappable rows — the read/edit surface the
	 *  reply-to-message flow never gave (you no longer scroll chat history to find one). */
	private async menuJots(ctx: any): Promise<void> {
		await ctx.answerCallbackQuery();
		const jots = await this.repo.recentJots(10);
		if (!jots.length)
			return void ctx.editMessageText("No jots yet.", {
				reply_markup: this.backTo("menu:root"),
			});
		const kb = new InlineKeyboard();
		for (const j of jots) {
			kb.text(
				`${STATUS_ICON[j.status]} ${j.time} ${jotPreview(j)}`,
				`menu:jot:${j.id}`,
			).row();
		}
		kb.text("‹ Back", "menu:root");
		await ctx.editMessageText("🗒 Recent jots:", { reply_markup: kb });
	}

	private async menuJotDetail(ctx: any, id?: string): Promise<void> {
		await ctx.answerCallbackQuery();
		const jot = id ? await this.repo.getJot(id) : undefined;
		if (!jot)
			return void ctx.editMessageText(`No jot ${id ?? ""}.`, {
				reply_markup: this.backTo("menu:jots"),
			});
		const kb = new InlineKeyboard()
			.text("🔄 Retry", `menu:jr:${jot.id}`)
			.text("✏️ Edit", `menu:je:${jot.id}`)
			.row()
			.text("🗑 Delete", `menu:jd:${jot.id}`)
			.row()
			.text("‹ Back", "menu:jots");
		await ctx.editMessageText(formatJotDetail(jot), { reply_markup: kb });
	}

	private async menuJotRetry(ctx: any, id?: string): Promise<void> {
		if (!id || !(await this.repo.getJot(id)))
			return void ctx.answerCallbackQuery({ text: "gone" });
		log.info({ jotId: id }, "menu: manual retry requested");
		await this.repo.resetForRetry(id);
		this.queue.add(id);
		await ctx.answerCallbackQuery({ text: "retrying" });
		await ctx.editMessageText(`🔄 retrying ${id}…`, {
			reply_markup: this.backTo("menu:jots"),
		});
	}

	private async menuJotDeleteConfirm(ctx: any, id?: string): Promise<void> {
		await ctx.answerCallbackQuery();
		if (!id) return;
		const kb = new InlineKeyboard()
			.text("🗑 Yes, delete", `menu:jdy:${id}`)
			.text("Cancel", `menu:jot:${id}`);
		await ctx.editMessageText(
			`Delete jot ${id}? This removes its line from the journal.`,
			{ reply_markup: kb },
		);
	}

	private async menuJotDelete(ctx: any, id?: string): Promise<void> {
		const jot = id ? await this.repo.getJot(id) : undefined;
		if (!jot) return void ctx.answerCallbackQuery({ text: "gone" });
		log.info({ jotId: id }, "menu: delete jot");
		const msg = await this.deleteJot(jot);
		await ctx.answerCallbackQuery({ text: "deleted" });
		await ctx.editMessageText(msg, { reply_markup: this.backTo("menu:jots") });
	}

	/** Edit from the menu: send a force-reply prompt mapped to the jot, so the reply routes
	 *  through the normal reply-edit path (handleEdit) with no new edit logic. */
	private async menuJotEdit(ctx: any, id?: string): Promise<void> {
		if (!id || !(await this.repo.getJot(id)))
			return void ctx.answerCallbackQuery({ text: "gone" });
		await ctx.answerCallbackQuery();
		log.info({ jotId: id }, "menu: edit jot — prompting for a reply");
		const sent = await this.bot.api.sendMessage(
			config.telegram.allowedUserId,
			`✏️ Reply to this message with your edit for ${id} (or "delete" to remove it).`,
			{
				reply_markup: {
					force_reply: true,
					input_field_placeholder: "your edit…",
				},
			},
		);
		await this.repo.mapMessage(sent.message_id, id);
	}

	/** Failed queue as tappable retry rows. Reuses the existing `rt:` retry handler. */
	private async menuFailed(ctx: any): Promise<void> {
		await ctx.answerCallbackQuery();
		const jots = await this.repo.failedJots(10);
		if (!jots.length)
			return void ctx.editMessageText("✅ nothing failed.", {
				reply_markup: this.backTo("menu:root"),
			});
		const lines = jots.map(
			(j) =>
				`${j.id} [${j.kind}] ${j.status} ×${j.attempts} — ${(j.error ?? "").slice(0, 60)}`,
		);
		const kb = new InlineKeyboard();
		for (const j of jots) kb.text(`🔄 ${j.id}`, `rt:${j.id}`).row();
		kb.text("‹ Back", "menu:root");
		await ctx.editMessageText(`⚠️ ${jots.length} failed:\n${lines.join("\n")}`, {
			reply_markup: kb,
		});
	}
}
