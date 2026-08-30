import { type Bot, InlineKeyboard } from "grammy";
import { config } from "../../config.ts";
import { escapeHtml, fitTelegram, makeJotId } from "../../core.ts";
import type { Repository, TaskDraftRow, TaskType } from "../../db.ts";
import { logger } from "../../log.ts";
import type { TaskStore } from "../../services/tasks.ts";
import { plainDate } from "../../time.ts";
import {
	detectionEnabled,
	filterTasks,
	isTaskType,
	parseTaskDate,
	parseTaskDraft,
	TASK_DETECTION_KEY,
	type TaskDraft,
	type TaskView,
	TYPE_LABEL,
	taskButtonLabel,
	taskCard,
	taskListLine,
	VIEW_LABEL,
} from "./parse.ts";

const log = logger("tasks-flow");

/** callback_query namespace this flow owns (see ScribaBot.handleButton). */
export const TASKS_NS = "tk";

/** Task mode closes itself after this long without a message, so it can't be left open by
 *  accident and swallow the next thing you meant to journal (same rule as command mode). */
const SESSION_TTL_MS = 15 * 60_000;

/** Rows per list page. Task descriptions are long, so a page is short. */
const PAGE = 8;

/** The list views offered on the task menu, in the order they're shown. */
const VIEWS: TaskView[] = [
	"day",
	"open",
	"overdue",
	"today",
	"week",
	"two",
	"done",
];

/** Is jot → task detection on right now? */
export async function taskDetectionEnabled(repo: Repository): Promise<boolean> {
	return detectionEnabled(await repo.getSetting(TASK_DETECTION_KEY));
}

/** Which change prompt a force-reply is answering — the marker rides in the prompt's own
 *  text, the same trick the habits flow and the link wizard use. */
export function parseTaskPromptRef(
	text: string,
): { field: "d" | "s" | "u"; id: string } | null {
	const m = text.match(/\(tk:(d|s|u):([0-9a-f]{6,16})\)/);
	return m ? { field: m[1] as "d" | "s" | "u", id: m[2]! } : null;
}

/**
 * Tasks: a sticky **task mode** where every message becomes one task, and the **task lists**
 * that mirror the Tasks-plugin queries in the vault's own dashboard.
 *
 * Nothing is ever written straight from a message. A message becomes a *draft* — parsed into
 * a description, a type and its two dates, token-free — and the draft is shown on a
 * confirmation card whose buttons change any of it. Only ✅ Create writes the note. Drafts
 * live in the DB rather than in memory: a description can't ride in Telegram's 64 bytes of
 * callback data, and a card whose buttons go dead on a restart is worse than one that
 * survives it.
 *
 * Created tasks are not tracked here at all — the two task notes stay the source of truth,
 * so a task you edit in Obsidian is still the task scriba lists and ticks.
 */
export class TasksFlow {
	private open = false;
	private idleTimer?: NodeJS.Timeout;
	/** draftId -> the force-reply prompts still on screen for it. A question is scaffolding,
	 *  not conversation: once it's answered (or the card settles) it comes back out of the
	 *  chat, leaving the card as the only record.
	 *  ponytail: in-memory, like ScribaBot's status-message map. A restart forgets at most
	 *  one unanswered prompt, which is a stale question rather than a broken one. */
	private prompts = new Map<string, number[]>();

	constructor(
		private bot: Bot,
		private repo: Repository,
		private store: TaskStore,
		/** Command mode owns the message stream too; the two never run at once. */
		private commandOpen: () => boolean,
	) {}

	register(): void {
		this.bot.command("task", (ctx) => this.start(ctx));
		this.bot.command("tasks", (ctx) => this.slashTasks(ctx));
	}

	isOpen(): boolean {
		return this.open;
	}

	// --- task mode ---

	async start(ctx: any): Promise<void> {
		if (this.commandOpen()) {
			log.warn("task mode refused — command mode is open");
			return void ctx.reply(
				"🧭 Command mode is open. Send /done to close it first, then /task.",
			);
		}
		if (this.open) {
			log.info("task mode already open");
			return void ctx.reply("📝 Task mode is already on. /done closes it.");
		}
		this.open = true;
		this.touch();
		log.info("task mode opened");
		await ctx.reply(
			[
				"📝 Task mode is on.",
				"",
				"Every message you send now becomes one task instead of a journal entry. Say when it's due in your own words — “review the RFC by next friday”, “buy cat sand next week”, “book the flights starting monday due in two weeks”.",
				"",
				"I'll show you what I understood before anything is written, and you can change the description, either date or the type from the buttons. Personal unless you say it's for work.",
				"",
				"/tasks lists what's open. Send /done when you're finished.",
			].join("\n"),
		);
	}

	/** Close task mode. Called by ScribaBot's /done, which closes whichever mode is open. */
	async finish(ctx: any): Promise<void> {
		this.close();
		log.info("task mode closed");
		await ctx.reply("📝 Task mode off — back to journaling.");
	}

	private close(): void {
		this.open = false;
		if (this.idleTimer) clearTimeout(this.idleTimer);
	}

	/** Restart the idle countdown — task mode shouldn't outlive your attention. */
	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (!this.open) return;
			log.info("task mode idle — closing");
			this.close();
			void this.bot.api
				.sendMessage(
					config.telegram.allowedUserId,
					"📝 Task mode timed out — back to journaling.",
				)
				.catch(() => {});
		}, SESSION_TTL_MS);
		this.idleTimer.unref?.();
	}

	/** One message while task mode is open: parse it into a draft and show the card. */
	async handle(ctx: any, text: string): Promise<void> {
		this.touch();
		const today = plainDate();
		const draft = parseTaskDraft(text, today);
		log.info(
			{
				chars: text.length,
				type: draft.type,
				start: draft.start,
				due: draft.due,
			},
			"task mode: message parsed",
		);
		if (!draft.description.trim()) {
			log.warn({ text }, "task mode: nothing to do in that message");
			return void ctx.reply(
				"I couldn't find anything to do in that — send the task itself, like “buy cat sand next week”.",
			);
		}
		const row = await this.saveDraft(draft, {
			source: "mode",
			jotId: null,
			sourceDate: today,
			chatId: ctx.chat?.id ?? config.telegram.allowedUserId,
		});
		await this.sendCard(row, "📝 New task");
	}

	/** Persist a draft (task mode or a jot suggestion) and hand back its row. */
	private async saveDraft(
		draft: TaskDraft,
		opts: {
			source: "mode" | "jot";
			jotId: string | null;
			sourceDate: string;
			chatId: number;
		},
	): Promise<TaskDraftRow> {
		const row: TaskDraftRow = {
			id: makeJotId(),
			source: opts.source,
			jot_id: opts.jotId,
			type: draft.type,
			description: draft.description.trim(),
			start: draft.start,
			due: draft.due,
			source_date: opts.sourceDate,
			status: "pending",
			chat_id: opts.chatId,
			message_id: null,
			created_at: Date.now(),
			updated_at: Date.now(),
		};
		await this.repo.insertTaskDraft(row);
		return row;
	}

	// --- feature 2: a task scriba spotted in a jot ---

	/**
	 * Propose a task found in a journal entry. Same card as task mode, plus a way to say it
	 * wasn't a task at all. A suggestion with no deadline asks for one straight away — a jot
	 * can be completely vague about when, and the deadline is the one field a task needs.
	 */
	async suggest(
		draft: TaskDraft,
		jotId: string,
		jotDate: string,
	): Promise<void> {
		const row = await this.saveDraft(draft, {
			source: "jot",
			jotId,
			sourceDate: jotDate,
			chatId: config.telegram.allowedUserId,
		});
		log.info(
			{ draft: row.id, jotId, due: row.due },
			"task suggested from a jot",
		);
		await this.sendCard(row, "📝 That sounds like a task");
		if (!row.due) await this.promptField(row, "u");
	}

	// --- the card ---

	private draftOf(row: TaskDraftRow): TaskDraft {
		return {
			description: row.description,
			type: row.type,
			start: row.start,
			due: row.due,
		};
	}

	private cardKeyboard(row: TaskDraftRow): InlineKeyboard {
		const id = row.id;
		return new InlineKeyboard()
			.text("✏️ Description", `${TASKS_NS}:d:${id}`)
			.text(`🔁 ${TYPE_LABEL[row.type]}`, `${TASKS_NS}:t:${id}`)
			.row()
			.text(`📅 Start: ${row.start ?? row.due ?? "—"}`, `${TASKS_NS}:s:${id}`)
			.text(`🏁 Due: ${row.due ?? "needed"}`, `${TASKS_NS}:u:${id}`)
			.row()
			.text("✅ Create", `${TASKS_NS}:ok:${id}`)
			.text(
				row.source === "jot" ? "🚫 Not a task" : "✖️ Cancel",
				`${TASKS_NS}:x:${id}`,
			);
	}

	private async sendCard(row: TaskDraftRow, header: string): Promise<void> {
		const msg = await this.bot.api
			.sendMessage(row.chat_id, taskCard(this.draftOf(row), header), {
				parse_mode: "HTML",
				reply_markup: this.cardKeyboard(row),
			})
			.catch((err) => {
				log.error({ err, draft: row.id }, "task card failed to send");
				return null;
			});
		if (msg)
			await this.repo.updateTaskDraft(row.id, { message_id: msg.message_id });
	}

	/** Redraw a card in place after a change. */
	private async redraw(
		row: TaskDraftRow,
		header = "📝 New task",
	): Promise<void> {
		if (!row.message_id) return this.sendCard(row, header);
		await this.bot.api
			.editMessageText(
				row.chat_id,
				row.message_id,
				taskCard(this.draftOf(row), header),
				{ parse_mode: "HTML", reply_markup: this.cardKeyboard(row) },
			)
			.catch((err) =>
				log.warn({ err, draft: row.id }, "task card redraw failed"),
			);
	}

	/** Final word on a card: no buttons, so a settled task can't be settled twice. */
	private async settle(row: TaskDraftRow, html: string): Promise<void> {
		const body = fitTelegram(html);
		if (!row.message_id) {
			await this.bot.api
				.sendMessage(row.chat_id, body, { parse_mode: "HTML" })
				.catch(() => {});
			return;
		}
		await this.bot.api
			.editMessageText(row.chat_id, row.message_id, body, {
				parse_mode: "HTML",
				reply_markup: new InlineKeyboard(),
			})
			.catch((err) =>
				log.warn({ err, draft: row.id }, "task card settle failed"),
			);
	}

	/** Ask for one field by force-reply; the marker in the prompt routes the answer back. */
	private async promptField(
		row: TaskDraftRow,
		field: "d" | "s" | "u",
	): Promise<void> {
		const prompts: Record<typeof field, string> = {
			d: `✏️ Reply to this message with what the task should say. (tk:d:${row.id})`,
			s: `📅 Reply to this message with the start date — a date, “next monday”, or “none” to leave it to the deadline. (tk:s:${row.id})`,
			u: `🏁 Reply to this message with the due date — a date, or something like “next friday”. This one it needs. (tk:u:${row.id})`,
		};
		const text = prompts[field];
		log.info({ draft: row.id, field }, "task: prompting for a field");
		// Deliberately NOT a force_reply: that points the compose box at this message the
		// moment it arrives, so a message you were already halfway through typing goes out
		// as the answer to a question you hadn't read yet. Replying by hand is one extra
		// tap; having your jot swallowed by a date prompt is worse.
		const msg = await this.bot.api
			.sendMessage(row.chat_id, text)
			.catch((err) => {
				log.warn({ err, draft: row.id, field }, "task: prompt failed to send");
				return null;
			});
		if (msg)
			this.prompts.set(row.id, [
				...(this.prompts.get(row.id) ?? []),
				msg.message_id,
			]);
	}

	/** Take a prompt back out of the chat once it has done its job. Best-effort: a message
	 *  older than 48 hours, or already gone, can't be deleted and isn't worth complaining
	 *  about. */
	private async dropPrompt(
		row: TaskDraftRow,
		messageId: number,
	): Promise<void> {
		const left = (this.prompts.get(row.id) ?? []).filter(
			(id) => id !== messageId,
		);
		if (left.length) this.prompts.set(row.id, left);
		else this.prompts.delete(row.id);
		await this.bot.api
			.deleteMessage(row.chat_id, messageId)
			.catch((err) =>
				log.debug(
					{ err, draft: row.id, messageId },
					"task: prompt already gone",
				),
			);
	}

	/** Clear every prompt still open for a draft — it has been created or dropped, so
	 *  nothing is waiting on an answer any more. */
	private async clearPrompts(row: TaskDraftRow): Promise<void> {
		for (const id of this.prompts.get(row.id) ?? [])
			await this.dropPrompt(row, id);
		this.prompts.delete(row.id);
	}

	/** True when `text` is one of this flow's force-reply prompts. */
	isTaskPrompt(text: string): boolean {
		return parseTaskPromptRef(text) !== null;
	}

	/** Route a reply to the change prompt that asked for it. */
	async handleReply(ctx: any, prompt: string): Promise<void> {
		const ref = parseTaskPromptRef(prompt);
		if (!ref) return;
		const row = await this.repo.getTaskDraft(ref.id);
		if (row?.status !== "pending") {
			log.warn(
				{ draft: ref.id, status: row?.status },
				"task reply: draft gone",
			);
			return void ctx.reply("That task is already settled.");
		}
		const body = String(ctx.message?.text ?? "").trim();
		// The prompt goes only once its answer lands: one that couldn't be read has to stay
		// on screen, or there'd be nothing left to reply to.
		const answered = ctx.message?.reply_to_message?.message_id;
		const done = async () => {
			if (answered) await this.dropPrompt(row, answered);
		};
		if (ref.field === "d") {
			if (!body) return void ctx.reply("Send the task text and I'll use it.");
			await this.repo.updateTaskDraft(row.id, { description: body });
			log.info({ draft: row.id }, "task: description changed");
			await done();
			return this.redraw({ ...row, description: body }, this.headerFor(row));
		}
		const date = parseTaskDate(body, plainDate());
		if (date === undefined) {
			log.warn({ draft: row.id, body }, "task: unreadable date reply");
			return void ctx.reply(
				'I couldn\'t read that as a date. Try "next friday", "in two weeks", or 2026-09-15.',
			);
		}
		if (ref.field === "u" && date === null) {
			log.warn({ draft: row.id }, "task: refused to clear the deadline");
			return void ctx.reply(
				"A task needs a deadline — give me a date for this one.",
			);
		}
		const patch = ref.field === "s" ? { start: date } : { due: date };
		await this.repo.updateTaskDraft(row.id, patch);
		log.info({ draft: row.id, field: ref.field, date }, "task: date changed");
		await done();
		return this.redraw({ ...row, ...patch }, this.headerFor(row));
	}

	private headerFor(row: TaskDraftRow): string {
		return row.source === "jot" ? "📝 That sounds like a task" : "📝 New task";
	}

	// --- callbacks ---

	/** Dispatch a `tk:<action>[:<args>]` callback. Routed in from ScribaBot.handleButton. */
	async handleTap(ctx: any, rest: string[]): Promise<void> {
		const [action, ...args] = rest;
		switch (action) {
			case "d":
			case "s":
			case "u":
				return this.tapPrompt(ctx, action, args[0]);
			case "t":
				return this.tapToggleType(ctx, args[0]);
			case "ok":
				return this.tapCreate(ctx, args[0]);
			case "x":
				return this.tapDrop(ctx, args[0]);
			case "m":
				await ctx.answerCallbackQuery();
				return this.showMenu(ctx, "edit");
			case "v":
				await ctx.answerCallbackQuery();
				return this.showView(
					ctx,
					(args[0] ?? "open") as TaskView,
					Math.max(0, Number(args[1]) || 0),
					"edit",
				);
			case "k":
			case "r":
				return this.tapTick(ctx, action === "k", args);
			case "det":
				return this.tapDetection(ctx);
			case "close":
				await ctx.answerCallbackQuery();
				log.info("tasks: screen closed");
				return void (await ctx.deleteMessage().catch(async () => {
					// >48h old, or already gone: clear the buttons instead of leaving them
					// tappable on a message that can no longer be removed.
					await ctx
						.editMessageText("🗂 Closed.", {
							reply_markup: new InlineKeyboard(),
						})
						.catch(() => {});
				}));
			default:
				log.warn({ action }, "tasks: unknown callback action");
				await ctx.answerCallbackQuery();
		}
	}

	/** A draft a tap refers to, or undefined once it's settled (with the toast said). */
	private async liveDraft(
		ctx: any,
		id?: string,
	): Promise<TaskDraftRow | undefined> {
		const row = id ? await this.repo.getTaskDraft(id) : undefined;
		if (!row) {
			log.warn({ draft: id }, "tasks: tap for an unknown draft");
			await ctx.answerCallbackQuery({ text: "expired" });
			return undefined;
		}
		if (row.status !== "pending") {
			log.warn(
				{ draft: id, status: row.status },
				"tasks: draft already settled",
			);
			await ctx.answerCallbackQuery({ text: `already ${row.status}` });
			return undefined;
		}
		return row;
	}

	private async tapPrompt(
		ctx: any,
		field: "d" | "s" | "u",
		id?: string,
	): Promise<void> {
		const row = await this.liveDraft(ctx, id);
		if (!row) return;
		await ctx.answerCallbackQuery({ text: "Answer the prompt below ↓" });
		await this.promptField(row, field);
	}

	private async tapToggleType(ctx: any, id?: string): Promise<void> {
		const row = await this.liveDraft(ctx, id);
		if (!row) return;
		const type: TaskType = row.type === "work" ? "personal" : "work";
		await ctx.answerCallbackQuery({ text: TYPE_LABEL[type] });
		await this.repo.updateTaskDraft(row.id, { type });
		log.info({ draft: row.id, type }, "task: type toggled");
		await this.redraw({ ...row, type }, this.headerFor(row));
	}

	private async tapCreate(ctx: any, id?: string): Promise<void> {
		const row = await this.liveDraft(ctx, id);
		if (!row) return;
		if (!row.due) {
			log.warn({ draft: row.id }, "task: create refused — no deadline");
			await ctx.answerCallbackQuery({ text: "it needs a due date first" });
			return this.promptField(row, "u");
		}
		// Claim it before writing anything: two fast taps both see a pending draft, and only
		// the one that wins the compare-and-swap may put a line in the note.
		if (!(await this.repo.claimTaskDraft(row.id))) {
			log.warn({ draft: row.id }, "task: create lost the claim");
			return void ctx.answerCallbackQuery({ text: "already created" });
		}
		// Answer before the vault round-trip, which can outlive Telegram's callback window.
		await ctx.answerCallbackQuery({ text: "creating…" });
		try {
			const line = await this.store.add(this.draftOf(row), row.source_date);
			log.info(
				{ draft: row.id, type: row.type, due: row.due },
				"task created from a card",
			);
			await this.clearPrompts(row);
			await this.settle(
				row,
				[
					`✅ Added to ${TYPE_LABEL[row.type]}`,
					`<blockquote>${escapeHtml(line)}</blockquote>`,
				].join("\n"),
			);
		} catch (err) {
			// The write failed, so the draft never became a task: hand it back so the card
			// still works and the ✅ can be tried again.
			log.error({ err, draft: row.id }, "task creation failed");
			await this.repo.updateTaskDraft(row.id, { status: "pending" });
			await this.redraw(row, this.headerFor(row));
			await this.bot.api
				.sendMessage(
					row.chat_id,
					`⚠️ Couldn't write that task: ${err instanceof Error ? err.message : String(err)}`,
				)
				.catch(() => {});
		}
	}

	private async tapDrop(ctx: any, id?: string): Promise<void> {
		const row = await this.liveDraft(ctx, id);
		if (!row) return;
		const dismissed = row.source === "jot";
		await ctx.answerCallbackQuery({
			text: dismissed ? "not a task" : "dropped",
		});
		await this.repo.updateTaskDraft(row.id, {
			status: dismissed ? "dismissed" : "cancelled",
		});
		log.info({ draft: row.id, source: row.source }, "task draft dropped");
		await this.clearPrompts(row);
		await this.settle(
			row,
			dismissed
				? `🚫 Not a task — left it in the journal.\n<blockquote>${escapeHtml(row.description)}</blockquote>`
				: `✖️ Dropped.\n<blockquote>${escapeHtml(row.description)}</blockquote>`,
		);
	}

	// --- lists ---

	/** `/tasks [view]` — the menu, or straight to a view. */
	private async slashTasks(ctx: any): Promise<void> {
		const arg = String(ctx.match ?? "")
			.trim()
			.toLowerCase();
		const view = VIEW_ALIASES[arg];
		log.info({ arg: arg || "(menu)", view }, "/tasks command");
		if (!arg) return this.showView(ctx, "future", 0, "send");
		if (!view) {
			log.warn({ arg }, "/tasks: unknown view");
			return void ctx.reply(
				`Usage: /tasks [${Object.keys(VIEW_ALIASES).join(" | ")}]`,
			);
		}
		return this.showView(ctx, view, 0, "send");
	}

	/** The task menu as a fresh message — /menu's entry point, which can't edit its own
	 *  message into this flow. */
	async promptRoot(): Promise<void> {
		log.info("tasks menu opened (via /menu)");
		await this.bot.api.sendMessage(config.telegram.allowedUserId, MENU_TEXT, {
			reply_markup: await this.menuKeyboard(),
		});
	}

	private async menuKeyboard(): Promise<InlineKeyboard> {
		const kb = new InlineKeyboard();
		for (const v of VIEWS) kb.text(VIEW_LABEL[v], `${TASKS_NS}:v:${v}:0`).row();
		const on = await taskDetectionEnabled(this.repo);
		kb.text(`🔎 Spot tasks in jots: ${on ? "on" : "off"}`, `${TASKS_NS}:det`);
		return this.withClose(kb);
	}

	/** Every task screen carries the same way out: one tap that deletes the message. Lists
	 *  don't self-destruct the way /menu's screens do — you read them, and the morning
	 *  summary has to survive until you've worked through it — so Close is how they go. */
	private withClose(kb: InlineKeyboard): InlineKeyboard {
		const rows = kb.inline_keyboard.filter((r) => r.length > 0);
		return InlineKeyboard.from(rows).row().text("✖ Close", `${TASKS_NS}:close`);
	}

	private async showMenu(ctx: any, mode: "edit" | "send"): Promise<void> {
		const kb = await this.menuKeyboard();
		if (mode === "edit")
			return void ctx.editMessageText(MENU_TEXT, { reply_markup: kb });
		await ctx.reply(MENU_TEXT, { reply_markup: kb });
	}

	/**
	 * Build one list view: the message body and its keyboard. Rows are tappable — an open
	 * task ticks, a done one reopens — and each row carries the digest of the line it was
	 * drawn from, so a tap that lands after the note changed is refused rather than acting
	 * on whatever has since moved into that position. Throws when the notes can't be read;
	 * every caller says so in its own way.
	 */
	private async viewMessage(
		view: TaskView,
		page: number,
		header?: string,
	): Promise<{ text: string; kb: InlineKeyboard; count: number }> {
		const today = plainDate();
		const tasks = filterTasks(await this.store.list(), view, today);
		const pages = Math.max(1, Math.ceil(tasks.length / PAGE));
		const p = Math.min(Math.max(page, 0), pages - 1);
		const shown = tasks.slice(p * PAGE, p * PAGE + PAGE);
		log.info(
			{ view, page: p, shown: shown.length, total: tasks.length },
			"tasks: list rendered",
		);

		const kb = new InlineKeyboard();
		shown.forEach((t, j) => {
			const n = p * PAGE + j + 1;
			const verb = t.state === "done" ? "r" : "k";
			kb.text(
				taskButtonLabel(t, n),
				`${TASKS_NS}:${verb}:${t.type}:${t.index}:${t.fingerprint}:${view}:${p}`,
			).row();
		});
		if (pages > 1) {
			if (p > 0) kb.text("‹ Prev", `${TASKS_NS}:v:${view}:${p - 1}`);
			if (p < pages - 1) kb.text("Next ›", `${TASKS_NS}:v:${view}:${p + 1}`);
			kb.row();
		}
		kb.text("‹ Tasks", `${TASKS_NS}:m`);

		const head = [
			header ?? `<b>${VIEW_LABEL[view]}</b>`,
			tasks.length
				? `${tasks.length} task${tasks.length === 1 ? "" : "s"}${pages > 1 ? ` · page ${p + 1}/${pages}` : ""} · tap one to ${view === "done" ? "reopen it" : "tick it off"}`
				: "Nothing here.",
			"",
		];
		const text = fitTelegram(
			[
				...head,
				...shown.map((t, j) => taskListLine(t, p * PAGE + j + 1, today)),
			].join("\n"),
		);
		return { text, kb: this.withClose(kb), count: tasks.length };
	}

	/** Show a list view, editing the tapped message or sending a fresh one. */
	private async showView(
		ctx: any,
		view: TaskView,
		page: number,
		mode: "edit" | "send",
	): Promise<void> {
		let out: { text: string; kb: InlineKeyboard };
		try {
			out = await this.viewMessage(view, page);
		} catch (err) {
			log.error({ err, view }, "tasks: could not read the task notes");
			const text = `⚠️ Couldn't read your task notes: ${err instanceof Error ? err.message : String(err)}`;
			return void (mode === "edit"
				? await ctx.editMessageText(text).catch(() => {})
				: await ctx.reply(text));
		}
		if (mode === "edit")
			return void (await ctx
				.editMessageText(out.text, {
					parse_mode: "HTML",
					reply_markup: out.kb,
				})
				.catch((err: unknown) =>
					log.warn({ err, view }, "tasks: list edit failed"),
				));
		await ctx.reply(out.text, { parse_mode: "HTML", reply_markup: out.kb });
	}

	/**
	 * The morning summary: what's due today plus whatever is still hanging over from before,
	 * sent unprompted at TASKS_TIME. Explicitly not silent — this is the one message of the
	 * day that is meant to interrupt, so it always arrives with a notification rather than
	 * inheriting any quieter default. (A chat muted in Telegram itself stays muted: no bot
	 * can override that, there is no API for it.)
	 *
	 * A day with nothing due sends nothing at all: a notification that says "no tasks" is
	 * an interruption that earns nothing, and the nightly journal summary already keeps
	 * quiet the same way. A failure is different — that still speaks up, since a morning
	 * with no summary should only ever mean an empty day.
	 */
	async dailySummary(): Promise<void> {
		const today = plainDate();
		const chat = config.telegram.allowedUserId;
		log.info({ date: today }, "tasks: sending the daily summary");
		try {
			const { text, kb, count } = await this.viewMessage(
				"day",
				0,
				`<b>🌅 Your tasks for ${today}</b>`,
			);
			if (count === 0) {
				log.info({ date: today }, "tasks: nothing due today — staying quiet");
				return;
			}
			await this.bot.api.sendMessage(chat, text, {
				parse_mode: "HTML",
				reply_markup: kb,
				disable_notification: false,
			});
			log.info({ date: today, tasks: count }, "tasks: daily summary sent");
		} catch (err) {
			log.error({ err }, "tasks: daily summary failed");
			// Still loud: a morning with no summary and no explanation reads as a dead bot.
			await this.bot.api
				.sendMessage(
					chat,
					`⚠️ Couldn't put together your task summary: ${err instanceof Error ? err.message : String(err)}`,
					{ disable_notification: false },
				)
				.catch(() => {});
		}
	}

	/** Tick (or reopen) the row a tap points at, then re-render the list it came from. */
	private async tapTick(
		ctx: any,
		done: boolean,
		args: string[],
	): Promise<void> {
		const [type, indexRaw, fingerprint, view, pageRaw] = args;
		const index = Number(indexRaw);
		if (!isTaskType(type) || !Number.isInteger(index) || !fingerprint) {
			log.warn({ args }, "tasks: malformed tick callback");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		// Answer first: the vault round-trip below can outlive Telegram's callback window,
		// and the re-rendered list is what actually carries the result.
		await ctx.answerCallbackQuery({ text: done ? "ticking…" : "reopening…" });
		const task = await this.store
			.setDone(type, index, fingerprint, done)
			.catch((err) => {
				log.error({ err, type, index }, "tasks: could not change that task");
				return null;
			});
		if (!task) {
			await this.bot.api
				.sendMessage(
					ctx.chat?.id ?? config.telegram.allowedUserId,
					"⚠️ That task moved or changed in Obsidian since this list was drawn — here it is again.",
				)
				.catch(() => {});
		} else {
			log.info(
				{ type, index, done, text: task.text },
				done ? "task ticked from a list" : "task reopened from a list",
			);
		}
		return this.showView(
			ctx,
			view && view in VIEW_LABEL ? (view as TaskView) : "open",
			Math.max(0, Number(pageRaw) || 0),
			"edit",
		);
	}

	private async tapDetection(ctx: any): Promise<void> {
		const on = await taskDetectionEnabled(this.repo);
		await this.repo.setSetting(TASK_DETECTION_KEY, on ? "off" : "on");
		log.info({ enabled: !on }, "tasks: jot detection toggled");
		await ctx.answerCallbackQuery({
			text: on ? "I'll stop suggesting tasks" : "I'll suggest tasks again",
		});
		return this.showMenu(ctx, "edit");
	}
}

const MENU_TEXT = [
	"🗂 Tasks",
	"",
	"Tap a list to see it. Tapping a task in an open list ticks it off; the done list reopens one.",
].join("\n");

/** What `/tasks <arg>` accepts, mapped onto the views. */
const VIEW_ALIASES: Record<string, TaskView> = {
	day: "day",
	all: "open",
	open: "open",
	overdue: "overdue",
	late: "overdue",
	today: "today",
	week: "week",
	two: "two",
	fortnight: "two",
	done: "done",
};
