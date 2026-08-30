import { type Bot, InlineKeyboard } from "grammy";
import { commands, type Deps } from "../commands/index.ts";
import { config } from "../config.ts";
import {
	cleanNoteTitle,
	distinctSurfaces,
	ENTRY_MAX_CHARS_KEY,
	entryMaxChars,
	fitTelegram,
	formatJotDetail,
	jotPreview,
	noteSuggestions,
	parseEntrySize,
	parseRuleWords,
	parseWizardRef,
	previewList,
	STATUS_ICON,
	WIZARD_ENTRYSIZE_REF,
	WIZARD_NEWNOTE_REF,
	WIZARD_NOTE_REF,
	WIZARD_REGISTER_REF,
	WIZARD_RENAME_REF,
	WIZARD_STOPWORD_REF,
} from "../core.ts";
import type { Jot } from "../db.ts";
import { logger } from "../log.ts";
import { plainDate } from "../time.ts";
import type { HabitsCommand } from "./habits/index.ts";
import type { RatingCommand } from "./rating.ts";
import type { ReprocessCommand } from "./reprocess.ts";
import type { TasksFlow } from "./tasks/index.ts";

const log = logger("menu");

/** The interactive /menu control panel — a callback-driven entry point layered over the
 *  slash commands, not a replacement. Every leaf reuses an existing command (via runCmd)
 *  or flow (rating/habits/reprocess prompts, jot edit/delete), so the menu adds an entry
 *  point but no new business logic. `getDeps` is lazy (mirrors ScribaBot.deps()) since the
 *  queue and processor aren't wired up yet when this class is constructed. */
export class MenuController {
	// Rejected-links menu page size (rows per page).
	private static readonly REJECT_PAGE = 8;
	// Never-link words named inline on the step-2 summary. Anything past this is counted,
	// not dropped — the full list is one tap away on "🗑 Remove a word", which pages.
	private static readonly STOPWORD_PREVIEW = 40;
	// Note-search page size. Smaller than REJECT_PAGE: note titles are long, and a wall of
	// them is exactly the "hard to find things" problem the picker exists to solve.
	private static readonly PICK_PAGE = 6;
	// The one place the wizard keeps state between messages: picking the note side means
	// searching a vault of thousands, which cannot ride in 64 bytes of callback data.
	// ponytail: in-memory and single-flow — one user, and a restart just drops a
	// half-finished add. Persist it only if that ever proves annoying.
	private pending?: {
		words: string[]; // surfaces still waiting for a note
		i: number; // which one we're on
		query: string; // current search text (seeded with the word itself)
		page: number;
		retarget?: { surface: string; note: string }; // pair being replaced, if editing
	};
	// A menu is a control panel, not journal content: one minute without a tap and it
	// deletes itself, so a finished (or abandoned) flow doesn't leave a stale screen and a
	// still-tappable keyboard sitting in the chat. Every tap restarts the countdown.
	private static readonly MENU_TTL_MS = 60_000;
	// chatId -> message id of the last root menu in that chat, so opening a fresh /menu
	// retires the old one instead of leaving stale, still-tappable keyboards piling up.
	// Keyed by chat (not a single field) since message ids are only unique per chat — the
	// allowed user can open /menu from more than one chat (e.g. a group, then a DM).
	private lastMenuMsgId = new Map<number, number>();
	// "<chatId>:<messageId>" -> its pending self-destruct timer.
	private expiry = new Map<string, NodeJS.Timeout>();

	constructor(
		private bot: Bot,
		private rating: RatingCommand,
		private habits: HabitsCommand,
		private reprocess: ReprocessCommand,
		private getDeps: () => Deps,
		private deleteJot: (jot: Jot) => Promise<string>,
	) {}

	/** Late-wired: TasksFlow needs collaborators that don't exist yet when the menu is
	 *  built (mirrors ScribaBot.setQueue). */
	private tasks?: TasksFlow;
	setTasks(tasks: TasksFlow): void {
		this.tasks = tasks;
	}

	/** (Re)start a menu message's idle countdown. Called when one is sent and again on every
	 *  tap, so the minute is measured from the last interaction, not from the send. */
	private scheduleExpiry(chatId: number, msgId: number): void {
		const key = `${chatId}:${msgId}`;
		this.cancelExpiry(chatId, msgId);
		const timer = setTimeout(() => {
			this.expiry.delete(key);
			log.info({ chatId, msgId }, "menu: idle, self-destructing");
			// Best-effort: the message may already be gone (closed, deleted by hand, >48h).
			this.bot.api.deleteMessage(chatId, msgId).catch(() => {});
			if (this.lastMenuMsgId.get(chatId) === msgId)
				this.lastMenuMsgId.delete(chatId);
		}, MenuController.MENU_TTL_MS);
		// Don't hold the process open just for a menu that nobody is going to tap.
		timer.unref?.();
		this.expiry.set(key, timer);
	}

	private cancelExpiry(chatId: number, msgId: number): void {
		const key = `${chatId}:${msgId}`;
		const t = this.expiry.get(key);
		if (!t) return;
		clearTimeout(t);
		this.expiry.delete(key);
	}

	/** Wire /menu. Callback taps are routed in from ScribaBot.handleButton. */
	register(): void {
		this.bot.command("menu", (ctx) => this.open(ctx));
	}

	/** /menu — send a fresh root menu. Later taps edit that message in place. */
	async open(ctx: any): Promise<void> {
		log.info("menu opened");
		// Retire the previous menu in this chat so old, stale keyboards don't linger tappable.
		const prev = this.lastMenuMsgId.get(ctx.chat.id);
		if (prev) {
			this.cancelExpiry(ctx.chat.id, prev);
			await ctx.api.deleteMessage(ctx.chat.id, prev).catch(() => {});
		}
		const sent = await ctx.reply("🗂 scriba control menu", {
			reply_markup: await this.rootMenu(),
		});
		this.lastMenuMsgId.set(ctx.chat.id, sent.message_id);
		this.scheduleExpiry(ctx.chat.id, sent.message_id);
	}

	/** The entry-size cap in force right now (0 = splitting off). */
	private async entrySize(): Promise<number> {
		return entryMaxChars(
			await this.getDeps().repo.getSetting(ENTRY_MAX_CHARS_KEY),
		);
	}

	private async rootMenu(): Promise<InlineKeyboard> {
		const size = await this.entrySize();
		return new InlineKeyboard()
			.text("📊 Rate today", "menu:rate")
			.text("🌱 Review habits", "menu:habits")
			.row()
			.text("🗒 Recent jots", "menu:jots")
			.row()
			.text("🗂 Tasks", "menu:tasks")
			.text("📝 Task mode", "menu:taskmode")
			.row()
			.text("🔁 Reprocess", "menu:reprocess")
			.row()
			.text("📈 Stats", "menu:stats")
			.text("🩺 Status", "menu:status")
			.row()
			.text("⚠️ Failed queue", "menu:failed")
			.row()
			.text(`🎙 Transcriber: ${this.getDeps().transcriber.mode}`, "menu:tx")
			.row()
			.text(`✂️ Entry size: ${size ? `${size} chars` : "off"}`, "menu:esz")
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

	private backTo(target: string): InlineKeyboard {
		return new InlineKeyboard().text("‹ Back", target);
	}

	/** Run a string-returning admin command from a callback and hand back its text. */
	private async runCmd(ctx: any, name: string, arg = ""): Promise<string> {
		const cmd = commands.find((c) => c.name === name);
		if (!cmd) return `unknown command ${name}`;
		const out = await cmd.run(ctx, arg, this.getDeps());
		// Backstop for every menu screen that renders a command's text: editMessageText is
		// subject to the same 4096-character cap as a send, and a rejected edit leaves the
		// menu frozen on the previous screen with no explanation.
		return typeof out === "string" ? fitTelegram(out) : "";
	}

	/** Dispatch a `menu:<action>[:<arg>]` callback. Routed in from ScribaBot.handleButton. */
	async handleCallback(ctx: any, rest: string[]): Promise<void> {
		const [action, arg, arg2] = rest;
		// Taps land on the message being edited in place, so restarting its countdown here
		// covers every screen the wizard renders without touching each one.
		const tapped = ctx.callbackQuery?.message;
		if (tapped) this.scheduleExpiry(tapped.chat.id, tapped.message_id);
		switch (action) {
			case "root":
				await ctx.answerCallbackQuery();
				return ctx.editMessageText("🗂 scriba control menu", {
					reply_markup: await this.rootMenu(),
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
			case "tasks":
				await ctx.answerCallbackQuery({ text: "Opening tasks below ↓" });
				return this.tasks?.promptRoot();
			case "taskmode":
				await ctx.answerCallbackQuery();
				return this.tasks?.start(ctx);
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
			case "esz":
				await ctx.answerCallbackQuery();
				return this.entrySizeMenu(ctx);
			case "ess":
				return this.setEntrySize(ctx, arg);
			case "esc":
				return this.promptEntrySize(ctx);
			case "maint":
				await ctx.answerCallbackQuery();
				return ctx.editMessageText("🛠 Maintenance", {
					reply_markup: this.maintMenu(),
				});
			// --- link-rules wizard (see the `lw` block below) ---
			case "links":
				return this.lwHome(ctx);
			case "lsw":
				return this.lwStopwords(ctx);
			case "lswa":
				return this.lwPrompt(ctx, "sw");
			case "lswl":
				await ctx.answerCallbackQuery();
				return this.lwStopwordPage(ctx, Number(arg) || 0);
			case "lswd":
				return this.lwStopwordDelete(ctx, arg);
			case "lrj":
				await ctx.answerCallbackQuery();
				return this.lwRejectedWords(ctx, Number(arg) || 0);
			case "lrjs":
				await ctx.answerCallbackQuery();
				return this.lwRejectedNotes(ctx, Number(arg), Number(arg2) || 0);
			case "lrju":
				return this.lwUnreject(ctx, arg, arg2);
			case "lrg":
				await ctx.answerCallbackQuery();
				return this.lwPairs(ctx, Number(arg) || 0);
			case "lrgv":
				await ctx.answerCallbackQuery();
				return this.lwPairDetail(ctx, Number(arg));
			case "lrga":
				return this.lwPrompt(ctx, "rg");
			case "lrgd":
				return this.lwPairDelete(ctx, arg);
			case "lrgw":
				return this.lwPrompt(ctx, "rgw", Number(arg));
			case "lrgt":
				return this.lwRetarget(ctx, Number(arg));
			case "lrgp":
				return this.lwPick(ctx, Number(arg));
			case "lrgn":
				await ctx.answerCallbackQuery();
				return this.showNotePicker(ctx, "edit", Number(arg) || 0);
			case "lrgq":
				return this.lwPrompt(ctx, "rgn");
			case "lrgm":
				return this.lwPrompt(ctx, "rgm");
			case "lrgs":
				return this.lwSkip(ctx);
			case "lrgc":
				return this.lwCancel(ctx);
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
			return ctx.editMessageText("📈 Stats range:", { reply_markup: kb });
		}
		const text = await this.runCmd(ctx, "stats", range);
		await ctx.editMessageText(text, {
			reply_markup: this.backTo("menu:stats"),
		});
	}

	/** Flip the transcriber to the other backend (persisted) and re-render the root. */
	private async menuToggleTranscriber(ctx: any): Promise<void> {
		const next =
			this.getDeps().transcriber.mode === "local" ? "remote" : "local";
		log.info({ next }, "menu: toggling transcriber");
		const out = await this.runCmd(ctx, "transcriber", next);
		await ctx.answerCallbackQuery({ text: out.slice(0, 200) });
		await ctx.editMessageText("🗂 scriba control menu", {
			reply_markup: await this.rootMenu(),
		});
	}

	// --- entry size ---
	// How long one journal entry may get before it's split across several bullets. A tweet
	// by default; the presets are the sizes worth one tap, anything else is typed.

	/** Character counts offered as one-tap presets. 0 turns splitting off entirely. */
	private static readonly ENTRY_SIZE_PRESETS = [140, 280, 560, 1000, 0];

	private async entrySizeMenu(ctx: any): Promise<void> {
		const current = await this.entrySize();
		log.info({ current }, "menu: entry size");
		const kb = new InlineKeyboard();
		for (const n of MenuController.ENTRY_SIZE_PRESETS) {
			const label = n ? `${n} chars` : "Don't split";
			kb.text(`${n === current ? "✅ " : ""}${label}`, `menu:ess:${n}`).row();
		}
		kb.text("✍️ Type a size", "menu:esc").row();
		kb.text("‹ Back", "menu:root");
		await ctx.editMessageText(
			[
				"✂️ Entry size",
				"",
				current
					? `Entries longer than ${current} characters are split into several journal lines.`
					: "Splitting is off — every jot stays on one line, however long.",
				"",
				"Splits land on topic boundaries where there are any, and on sentence ends otherwise. A sentence is never cut in half.",
			].join("\n"),
			{ reply_markup: kb },
		);
	}

	private async setEntrySize(ctx: any, arg?: string): Promise<void> {
		const n = arg === undefined ? Number.NaN : Number(arg);
		if (!Number.isInteger(n) || n < 0) {
			log.warn({ arg }, "menu: bad entry size");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		await ctx.answerCallbackQuery({ text: n ? `${n} chars` : "splitting off" });
		await this.getDeps().repo.setSetting(ENTRY_MAX_CHARS_KEY, String(n));
		log.info({ size: n }, "menu: entry size changed");
		return this.entrySizeMenu(ctx);
	}

	/** Free-text size: a keyboard can't offer every number, so ask and route the reply back
	 *  by the marker in the prompt (the same trick the link wizard uses). */
	private async promptEntrySize(ctx: any): Promise<void> {
		await ctx.answerCallbackQuery({ text: "Answer the prompt below ↓" });
		log.info("menu: prompting for a custom entry size");
		// No force_reply anywhere in the menu: it points the compose box at the prompt the
		// instant it arrives, so a message already being typed is sent as the answer.
		await this.bot.api.sendMessage(
			config.telegram.allowedUserId,
			`✂️ Reply to this message with how many characters one journal entry may be: 40–4000, or "off" to stop splitting. ${WIZARD_ENTRYSIZE_REF}`,
		);
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

	// --- link-rules wizard ---
	// The three ways to steer the enricher's wikilinks, as one guided flow instead of a
	// pile of typed commands: step 1 picks the rule kind, step 2 the word, step 3 the note
	// (or the removal). Every screen carries a breadcrumb and a step counter.
	//
	// No state is held between taps. Rows index into deterministically ordered lists that
	// are re-derived on every callback, so an index that no longer resolves answers
	// "expired" instead of acting on the wrong row. Adding a rule needs free text, which a
	// keyboard can't collect, so those two leaves send a force-reply prompt and route the
	// answer back by the marker in the prompt text (see parseWizardRef in core.ts).

	/** Step 1 — which kind of link rule to change, with live counts and index health. */
	private async lwHome(ctx: any): Promise<void> {
		await ctx.answerCallbackQuery();
		const { repo, links } = this.getDeps();
		const [stops, rejects, forced] = await Promise.all([
			repo.stopwordList(),
			repo.rejectionList(),
			repo.registeredLinks(),
		]);
		const idx = links.stats();
		log.info(
			{
				stopwords: stops.length,
				rejections: rejects.length,
				forced: forced.length,
			},
			"link wizard: step 1",
		);
		const kb = new InlineKeyboard()
			.text(`🔗 Always link · ${forced.length}`, "menu:lrg")
			.row()
			.text(`🔇 Never link · ${stops.length}`, "menu:lsw")
			.row()
			.text(`🚫 Rejected pairs · ${rejects.length}`, "menu:lrj:0")
			.row()
			.text("‹ Back", "menu:root");
		await ctx.editMessageText(
			[
				"🔗 Link rules — step 1 of 3",
				"",
				"Which rule do you want to change?",
				"",
				`🔗 ${forced.length} word→note pair(s) always linked.`,
				`🔇 ${stops.length} word(s) never become a wikilink.`,
				`🚫 ${rejects.length} word→note pair(s) rejected.`,
				idx.enabled
					? `📇 vault index: ${idx.aliases} alias(es) across ${idx.files} note(s).`
					: "📇 vault index disabled — nothing is being linked.",
			].join("\n"),
			{ reply_markup: kb },
		);
	}

	/** Step 2 (never-link) — add a word, or go on to pick one to drop. */
	private async lwStopwords(ctx: any): Promise<void> {
		await ctx.answerCallbackQuery();
		const stops = await this.getDeps().repo.stopwordList();
		const preview = MenuController.STOPWORD_PREVIEW;
		const hidden = Math.max(0, stops.length - preview);
		log.info(
			{ stopwords: stops.length, hidden },
			"link wizard: never-link step",
		);
		const kb = new InlineKeyboard().text("➕ Add a word", "menu:lswa").row();
		if (stops.length) kb.text("🗑 Remove a word", "menu:lswl:0").row();
		kb.text("‹ Back", "menu:links");
		const lines = [
			"🔗 Link rules › 🔇 Never link — step 2 of 3",
			"",
			stops.length
				? `${stops.length} word(s) are skipped as link candidates:`
				: "No never-link words yet.",
		];
		// A summary, not the list: previewList names the leftovers instead of cutting them
		// off, and "🗑 Remove a word" pages through every word.
		if (stops.length) lines.push(previewList(stops, preview));
		if (hidden)
			lines.push("", 'Tap "🗑 Remove a word" to page through all of them.');
		await ctx.editMessageText(fitTelegram(lines.join("\n")), {
			reply_markup: kb,
		});
	}

	/** Step 3 (never-link) — one page of words, tap to allow linking again. */
	private async lwStopwordPage(ctx: any, page = 0): Promise<void> {
		const PAGE = MenuController.REJECT_PAGE;
		const stops = await this.getDeps().repo.stopwordList();
		if (!stops.length)
			return ctx.editMessageText("🔇 No never-link words left.", {
				reply_markup: this.backTo("menu:lsw"),
			});
		const pages = Math.ceil(stops.length / PAGE);
		const p = Math.min(Math.max(page, 0), pages - 1);
		const kb = new InlineKeyboard();
		stops.slice(p * PAGE, p * PAGE + PAGE).forEach((w, j) => {
			kb.text(`🗑 ${w}`.slice(0, 60), `menu:lswd:${p * PAGE + j}`).row();
		});
		if (pages > 1) {
			if (p > 0) kb.text("‹ Prev", `menu:lswl:${p - 1}`);
			if (p < pages - 1) kb.text("Next ›", `menu:lswl:${p + 1}`);
			kb.row();
		}
		kb.text("‹ Back", "menu:lsw");
		await ctx.editMessageText(
			[
				"🔗 Link rules › 🔇 Never link › 🗑 Remove — step 3 of 3",
				"",
				`Tap a word to let it be linked again.${pages > 1 ? ` (page ${p + 1}/${pages})` : ""}`,
			].join("\n"),
			{ reply_markup: kb },
		);
	}

	/** Drop the never-link word at global index `arg`, then re-render its page. */
	private async lwStopwordDelete(ctx: any, arg?: string): Promise<void> {
		const { repo } = this.getDeps();
		const stops = await repo.stopwordList();
		const gi = arg === undefined ? -1 : Number(arg);
		const word = stops[gi];
		if (word === undefined) {
			log.warn({ arg }, "link wizard: stopword index out of range");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		// Answer before the write, so a slow DB round-trip can't outlive Telegram's
		// callback-query window — the re-rendered page carries the result.
		await ctx.answerCallbackQuery();
		const n = await repo.delStopword(word);
		log.info({ word, removed: n }, "link wizard: never-link word removed");
		return this.lwStopwordPage(
			ctx,
			Math.floor(gi / MenuController.REJECT_PAGE),
		);
	}

	/** Step 2 (rejections) — one page of rejected words. */
	private async lwRejectedWords(ctx: any, page = 0): Promise<void> {
		const PAGE = MenuController.REJECT_PAGE;
		const list = await this.getDeps().repo.rejectionList();
		if (!list.length)
			return ctx.editMessageText("🚫 No rejected links.", {
				reply_markup: this.backTo("menu:links"),
			});
		const surfaces = distinctSurfaces(list);
		const pages = Math.ceil(surfaces.length / PAGE);
		const p = Math.min(Math.max(page, 0), pages - 1);
		const kb = new InlineKeyboard();
		surfaces.slice(p * PAGE, p * PAGE + PAGE).forEach((s, j) => {
			const n = list.filter((r) => r.surface === s).length;
			kb.text(
				`🚫 ${s} · ${n} note(s)`.slice(0, 60),
				`menu:lrjs:${p * PAGE + j}`,
			).row();
		});
		if (pages > 1) {
			if (p > 0) kb.text("‹ Prev", `menu:lrj:${p - 1}`);
			if (p < pages - 1) kb.text("Next ›", `menu:lrj:${p + 1}`);
			kb.row();
		}
		kb.text("‹ Back", "menu:links");
		await ctx.editMessageText(
			[
				"🔗 Link rules › 🚫 Rejected pairs — step 2 of 3",
				"",
				`Pick the word whose rejection you want to undo.${pages > 1 ? ` (page ${p + 1}/${pages})` : ""}`,
			].join("\n"),
			{ reply_markup: kb },
		);
	}

	/** Step 3 (rejections) — the notes rejected for surface `si`, tap one to allow it.
	 *  Paged like every other row list: one surface can carry more rejected notes than fit
	 *  in a single keyboard, and a word rejected everywhere is exactly the one you come
	 *  here to fix. */
	private async lwRejectedNotes(ctx: any, si: number, page = 0): Promise<void> {
		const PAGE = MenuController.REJECT_PAGE;
		const list = await this.getDeps().repo.rejectionList();
		const surface = distinctSurfaces(list)[si];
		if (surface === undefined) {
			log.warn({ si }, "link wizard: surface index out of range");
			return this.lwRejectedWords(ctx, 0);
		}
		const notes = list.filter((r) => r.surface === surface).map((r) => r.note);
		const pages = Math.max(1, Math.ceil(notes.length / PAGE));
		const p = Math.min(Math.max(page, 0), pages - 1);
		const kb = new InlineKeyboard();
		// Row indices stay global so lwUnreject resolves them against the whole note list.
		notes.slice(p * PAGE, p * PAGE + PAGE).forEach((n, j) => {
			kb.text(`↩️ ${n}`.slice(0, 60), `menu:lrju:${si}:${p * PAGE + j}`).row();
		});
		if (pages > 1) {
			if (p > 0) kb.text("‹ Prev", `menu:lrjs:${si}:${p - 1}`);
			if (p < pages - 1) kb.text("Next ›", `menu:lrjs:${si}:${p + 1}`);
			kb.row();
		}
		kb.text(
			"‹ Back",
			`menu:lrj:${Math.floor(si / MenuController.REJECT_PAGE)}`,
		);
		await ctx.editMessageText(
			[
				`🔗 Link rules › 🚫 ${surface} — step 3 of 3`,
				"",
				`${notes.length} note(s) rejected. Tap one to let "${surface}" link to it again.${pages > 1 ? ` (page ${p + 1}/${pages})` : ""}`,
			].join("\n"),
			{ reply_markup: kb },
		);
	}

	/** Undo the surface→note rejection at (`a`, `b`), then re-render where it came from. */
	private async lwUnreject(ctx: any, a?: string, b?: string): Promise<void> {
		const { repo } = this.getDeps();
		const list = await repo.rejectionList();
		const si = Number(a);
		const surface = distinctSurfaces(list)[si];
		const note =
			surface === undefined
				? undefined
				: list.filter((r) => r.surface === surface).map((r) => r.note)[
						Number(b)
					];
		if (surface === undefined || note === undefined) {
			log.warn({ a, b }, "link wizard: rejection index out of range");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		await ctx.answerCallbackQuery();
		const n = await repo.unreject(surface, note);
		log.info({ surface, note, removed: n }, "link wizard: rejection undone");
		// The surface disappears from step 2 once its last note is freed, so fall back
		// there rather than re-rendering an empty note list.
		const left = (await repo.rejectionList()).some(
			(r) => r.surface === surface,
		);
		return left
			? this.lwRejectedNotes(
					ctx,
					si,
					Math.floor(Number(b) / MenuController.REJECT_PAGE),
				)
			: this.lwRejectedWords(ctx, Math.floor(si / MenuController.REJECT_PAGE));
	}

	/** Step 2 (always-link) — one page of pairs. Tap a pair to edit or drop it. */
	private async lwPairs(ctx: any, page = 0): Promise<void> {
		const PAGE = MenuController.REJECT_PAGE;
		const forced = await this.getDeps().repo.registeredLinks();
		log.info({ forced: forced.length, page }, "link wizard: always-link step");
		const kb = new InlineKeyboard().text("➕ Add word(s)", "menu:lrga").row();
		const pages = Math.max(1, Math.ceil(forced.length / PAGE));
		const p = Math.min(Math.max(page, 0), pages - 1);
		forced.slice(p * PAGE, p * PAGE + PAGE).forEach((r, j) => {
			kb.text(
				`${r.surface} → ${r.note}`.slice(0, 60),
				`menu:lrgv:${p * PAGE + j}`,
			).row();
		});
		if (pages > 1) {
			if (p > 0) kb.text("‹ Prev", `menu:lrg:${p - 1}`);
			if (p < pages - 1) kb.text("Next ›", `menu:lrg:${p + 1}`);
			kb.row();
		}
		kb.text("‹ Back", "menu:links");
		await ctx.editMessageText(
			[
				"🔗 Link rules › 🔗 Always link — step 2 of 3",
				"",
				forced.length
					? `${forced.length} pair(s) linked with no judgment call. Tap one to change it.${pages > 1 ? ` (page ${p + 1}/${pages})` : ""}`
					: "No always-link pairs yet.",
			].join("\n"),
			{ reply_markup: kb },
		);
	}

	/** Step 3 (always-link) — what you can do to one pair: retarget, rename, or drop. */
	private async lwPairDetail(ctx: any, gi: number): Promise<void> {
		const forced = await this.getDeps().repo.registeredLinks();
		const r = forced[gi];
		if (!r) {
			log.warn({ gi }, "link wizard: pair index out of range");
			return this.lwPairs(ctx, 0);
		}
		const kb = new InlineKeyboard()
			.text("🔁 Change note", `menu:lrgt:${gi}`)
			.row()
			.text("✏️ Rename word", `menu:lrgw:${gi}`)
			.row()
			.text("🗑 Delete pair", `menu:lrgd:${gi}`)
			.row()
			.text(
				"‹ Back",
				`menu:lrg:${Math.floor(gi / MenuController.REJECT_PAGE)}`,
			);
		await ctx.editMessageText(
			[
				`🔗 Link rules › 🔗 Always link › ${r.surface} — step 3 of 3`,
				"",
				`"${r.surface}" always links to [[${r.note}]].`,
			].join("\n"),
			{ reply_markup: kb },
		);
	}

	/** Drop the pair at global index `arg`, then re-render its page. */
	private async lwPairDelete(ctx: any, arg?: string): Promise<void> {
		const { repo } = this.getDeps();
		const forced = await repo.registeredLinks();
		const gi = arg === undefined ? -1 : Number(arg);
		const r = forced[gi];
		if (!r) {
			log.warn({ arg }, "link wizard: pair index out of range");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		// Answer before the write, so a slow DB round-trip can't outlive Telegram's
		// callback-query window — the re-rendered page carries the result.
		await ctx.answerCallbackQuery({ text: `dropped ${r.surface}` });
		const n = await repo.delRegisteredLink(r.surface, r.note);
		log.info(
			{ surface: r.surface, note: r.note, removed: n },
			"link wizard: always-link pair removed",
		);
		return this.lwPairs(ctx, Math.floor(gi / MenuController.REJECT_PAGE));
	}

	/** "Change note" on an existing pair: reuse the picker, remembering what to replace. */
	private async lwRetarget(ctx: any, gi: number): Promise<void> {
		const forced = await this.getDeps().repo.registeredLinks();
		const r = forced[gi];
		if (!r) {
			log.warn({ gi }, "link wizard: retarget index out of range");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		await ctx.answerCallbackQuery();
		log.info({ surface: r.surface, note: r.note }, "link wizard: retargeting");
		this.pending = {
			words: [r.surface],
			i: 0,
			query: r.surface,
			page: 0,
			retarget: { ...r },
		};
		return this.showNotePicker(ctx, "edit", 0);
	}

	/** Force-reply prompts — the three places a rule needs free text no keyboard can give.
	 *  The answer routes back through handleWizardReply by the marker in the prompt. */
	private async lwPrompt(
		ctx: any,
		kind: "sw" | "rg" | "rgn" | "rgm" | "rgw",
		gi?: number,
	): Promise<void> {
		await ctx.answerCallbackQuery({ text: "Answer the prompt below ↓" });
		log.info({ kind, gi }, "link wizard: prompting");
		const word = this.pending?.words[this.pending.i];
		const prompts: Record<typeof kind, string> = {
			sw: `➕ Reply to this message with the word(s) that should never be linked. One per line, or comma-separated. ${WIZARD_STOPWORD_REF}`,
			rg: `➕ Reply to this message with the word(s) that should always link. One per line, or comma-separated — spaces are fine, and I'll ask for each one's note next. ${WIZARD_REGISTER_REF}`,
			rgn: `🔎 Search the vault for the note${word ? ` "${word}" should link to` : ""}. Reply to this message with any part of its title. ${WIZARD_NOTE_REF}`,
			rgm: `✍️ Reply to this message with the exact title of the note${word ? ` "${word}" should link to` : ""} — it doesn't have to exist yet. ${WIZARD_NEWNOTE_REF}`,
			rgw: `✏️ Reply to this message with the new word for this pair. ${`(${WIZARD_RENAME_REF}:${gi})`}`,
		};
		const text = prompts[kind];
		await this.bot.api.sendMessage(config.telegram.allowedUserId, text);
	}

	/** The note picker: search results from the vault index as tappable rows. This is the
	 *  step that used to mean typing an exact title from memory across thousands of notes.
	 *  `mode` is "edit" from a button tap and "send" after a force-reply (which arrives as
	 *  a new message, so there's nothing in place to edit). */
	private async showNotePicker(
		ctx: any,
		mode: "edit" | "send",
		page = 0,
	): Promise<void> {
		const p = this.pending;
		if (!p) return void ctx.reply("That link flow expired — reopen /menu.");
		const word = p.words[p.i];
		if (word === undefined) return this.finishPending(ctx, mode);

		const PAGE = MenuController.PICK_PAGE;
		const hits = noteSuggestions(p.query, this.getDeps().links.list());
		const pages = Math.max(1, Math.ceil(hits.length / PAGE));
		p.page = Math.min(Math.max(page, 0), pages - 1);
		const shown = hits.slice(p.page * PAGE, p.page * PAGE + PAGE);

		const kb = new InlineKeyboard();
		shown.forEach((note, j) => {
			kb.text(`📝 ${note}`.slice(0, 60), `menu:lrgp:${j}`).row();
		});
		if (pages > 1) {
			if (p.page > 0) kb.text("‹ Prev", `menu:lrgn:${p.page - 1}`);
			if (p.page < pages - 1) kb.text("Next ›", `menu:lrgn:${p.page + 1}`);
			kb.row();
		}
		kb.text("🔎 Search by another name", "menu:lrgq").row();
		kb.text("✍️ Type a note that doesn't exist yet", "menu:lrgm").row();
		if (p.words.length > 1) kb.text("⏭ Skip this word", "menu:lrgs");
		kb.text("✖ Cancel", "menu:lrgc");

		const queue =
			p.words.length > 1 ? ` (word ${p.i + 1} of ${p.words.length})` : "";
		const text = [
			`🔗 "${word}" → which note?${queue}`,
			"",
			hits.length
				? `${hits.length} match(es) for "${p.query}"${pages > 1 ? `, page ${p.page + 1}/${pages}` : ""}. Tap one, or search again.`
				: `Nothing in the vault matches "${p.query}". Search again with another part of the title.`,
		].join("\n");

		if (mode === "edit") return ctx.editMessageText(text, { reply_markup: kb });
		return this.sendMenu(text, kb);
	}

	/** Send a menu screen of our own (not an edit of a tapped one) and start its countdown. */
	private async sendMenu(text: string, kb: InlineKeyboard): Promise<void> {
		const sent = await this.bot.api.sendMessage(
			config.telegram.allowedUserId,
			text,
			{ reply_markup: kb },
		);
		this.scheduleExpiry(sent.chat.id, sent.message_id);
	}

	/** A tapped suggestion: save the pair (replacing the old note when retargeting) and
	 *  move to the next queued word. */
	private async lwPick(ctx: any, j: number): Promise<void> {
		const p = this.pending;
		const word = p?.words[p.i];
		if (!p || word === undefined) {
			log.warn("link wizard: pick with no pending flow");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		const PAGE = MenuController.PICK_PAGE;
		const hits = noteSuggestions(p.query, this.getDeps().links.list());
		const note = hits[p.page * PAGE + j];
		if (note === undefined) {
			log.warn({ j, page: p.page }, "link wizard: suggestion out of range");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		await ctx.answerCallbackQuery({ text: `${word} → ${note}` });
		return this.savePair(ctx, word, note);
	}

	/** Write one pair, retiring the pair being replaced when this is a retarget. `mode` is
	 *  how the next screen gets drawn — "send" when we got here from a force-reply. */
	private async savePair(
		ctx: any,
		word: string,
		note: string,
		mode: "edit" | "send" = "edit",
	): Promise<void> {
		const { repo } = this.getDeps();
		const old = this.pending?.retarget;
		if (old) await repo.delRegisteredLink(old.surface, old.note);
		await repo.addRegisteredLink(word, note);
		log.info(
			{ surface: word, note, replaced: old?.note },
			"link wizard: pair saved",
		);
		return this.advance(ctx, mode);
	}

	/** Move the queue on: next word gets its own picker, an empty queue ends the flow. */
	private async advance(
		ctx: any,
		mode: "edit" | "send" = "edit",
	): Promise<void> {
		const p = this.pending;
		if (!p) return this.lwPairs(ctx, 0);
		p.i += 1;
		const next = p.words[p.i];
		if (next === undefined) return this.finishPending(ctx, mode);
		p.query = next;
		return this.showNotePicker(ctx, mode, 0);
	}

	private async finishPending(ctx: any, mode: "edit" | "send"): Promise<void> {
		const done = this.pending?.words.length ?? 0;
		this.pending = undefined;
		log.info({ words: done }, "link wizard: pair flow finished");
		if (mode === "edit") return this.lwPairs(ctx, 0);
		// Arrived from a reply, so there's no menu message here to edit — send a fresh one.
		await this.sendMenu(
			"🔗 Always-link rules updated.",
			new InlineKeyboard().text("🔗 Link rules", "menu:links"),
		);
	}

	private async lwSkip(ctx: any): Promise<void> {
		await ctx.answerCallbackQuery({ text: "skipped" });
		log.info(
			{ word: this.pending?.words[this.pending.i] },
			"link wizard: word skipped",
		);
		return this.advance(ctx);
	}

	private async lwCancel(ctx: any): Promise<void> {
		await ctx.answerCallbackQuery({ text: "cancelled" });
		log.info("link wizard: pair flow cancelled");
		this.pending = undefined;
		return this.lwPairs(ctx, 0);
	}

	/** True when `text` is one of the wizard's own force-reply prompts (ScribaBot checks
	 *  this before treating a reply as a jot edit). */
	isWizardPrompt(text: string): boolean {
		return parseWizardRef(text) !== null;
	}

	/** Route a reply to the prompt that asked for it. */
	async handleWizardReply(ctx: any, prompt: string): Promise<void> {
		const { repo } = this.getDeps();
		const p = parseWizardRef(prompt);
		if (!p) return;
		const body = ctx.message?.text ?? "";

		switch (p.kind) {
			case "sw": {
				const words = parseRuleWords(body);
				if (!words.length) {
					log.warn({ body }, "link wizard: empty never-link reply");
					return void ctx.reply("Nothing to add — send a word.");
				}
				for (const w of words) await repo.addStopword(w);
				log.info({ words }, "link wizard: never-link words added");
				return void ctx.reply(`🔇 never linking: ${words.join(", ")}`, {
					reply_markup: new InlineKeyboard().text(
						"🔗 Link rules",
						"menu:links",
					),
				});
			}
			case "rg": {
				const words = parseRuleWords(body);
				if (!words.length) {
					log.warn({ body }, "link wizard: empty always-link reply");
					return void ctx.reply("Nothing to add — send a word.");
				}
				log.info({ words }, "link wizard: queued words needing a note");
				this.pending = { words, i: 0, query: words[0] ?? "", page: 0 };
				return this.showNotePicker(ctx, "send", 0);
			}
			case "rgn": {
				if (!this.pending) {
					log.warn("link wizard: search reply with no pending flow");
					return void ctx.reply("That link flow expired — reopen /menu.");
				}
				this.pending.query = cleanNoteTitle(body);
				log.info({ query: this.pending.query }, "link wizard: note search");
				return this.showNotePicker(ctx, "send", 0);
			}
			case "rgm": {
				const p2 = this.pending;
				const word = p2?.words[p2.i];
				if (!p2 || word === undefined) {
					log.warn("link wizard: manual note reply with no pending flow");
					return void ctx.reply("That link flow expired — reopen /menu.");
				}
				const note = cleanNoteTitle(body);
				if (!note) {
					log.warn({ body }, "link wizard: empty manual note reply");
					return void ctx.reply("Nothing to link to — send a note title.");
				}
				log.info({ surface: word, note }, "link wizard: manual note title");
				await ctx.reply(`🔗 "${word}" → [[${note}]]`);
				return this.savePair(ctx, word, note, "send");
			}
			case "rgw": {
				const forced = await repo.registeredLinks();
				const r = forced[p.index];
				if (!r) {
					log.warn({ index: p.index }, "link wizard: rename target is gone");
					return void ctx.reply("That pair is gone — reopen /menu.");
				}
				const [word] = parseRuleWords(body, 1);
				if (!word) {
					log.warn({ body }, "link wizard: empty rename reply");
					return void ctx.reply("Nothing to rename to — send a word.");
				}
				await repo.delRegisteredLink(r.surface, r.note);
				await repo.addRegisteredLink(word, r.note);
				log.info({ from: r.surface, to: word }, "link wizard: pair renamed");
				return void ctx.reply(`✏️ "${word}" always links to [[${r.note}]]`, {
					reply_markup: new InlineKeyboard().text(
						"🔗 Link rules",
						"menu:links",
					),
				});
			}
			case "es": {
				const size = parseEntrySize(body);
				if (size === null) {
					log.warn({ body }, "menu: unusable entry size reply");
					return void ctx.reply(
						'Give me a whole number between 40 and 4000, or "off".',
					);
				}
				await repo.setSetting(ENTRY_MAX_CHARS_KEY, String(size));
				log.info({ size }, "menu: entry size changed");
				return void ctx.reply(
					size
						? `✂️ entries split above ${size} characters`
						: "✂️ splitting off — entries stay on one line",
					{
						reply_markup: new InlineKeyboard().text("✂️ Entry size", "menu:esz"),
					},
				);
			}
			default:
				return void (p satisfies never);
		}
	}

	/** Close the menu — the control panel is transient, not part of the journal. */
	private async menuClose(ctx: any): Promise<void> {
		log.info("menu closed");
		await ctx.answerCallbackQuery();
		this.lastMenuMsgId.delete(ctx.chat.id);
		this.cancelExpiry(
			ctx.chat.id,
			ctx.callbackQuery?.message?.message_id ?? -1,
		);
		try {
			await ctx.deleteMessage();
		} catch (e) {
			// Delete can fail (already gone, >48h old); leave a tidy closed state instead.
			log.warn({ err: e }, "menu close: delete failed, editing instead");
			// An empty InlineKeyboard actually clears the buttons; `reply_markup: undefined`
			// is dropped from the JSON payload, so Telegram would leave the old ones tappable.
			await ctx.editMessageText("🗂 Menu closed.", {
				reply_markup: new InlineKeyboard(),
			});
		}
	}

	/** Run a no-arg maintenance command and show its result over the maintenance menu. */
	private async menuMaint(ctx: any, name: string, arg = ""): Promise<void> {
		log.info({ cmd: name, arg }, "menu: maintenance action");
		// Answer before running the command (flush/sweep can be slow) — the edited message
		// carries the result instead of a toast that might arrive after Telegram gives up.
		await ctx.answerCallbackQuery();
		const out = await this.runCmd(ctx, name, arg);
		await ctx.editMessageText(out || "done", {
			reply_markup: this.maintMenu(),
		});
	}

	/** The jots browser: recent jots as tappable rows — the read/edit surface the
	 *  reply-to-message flow never gave (you no longer scroll chat history to find one). */
	private async menuJots(ctx: any): Promise<void> {
		await ctx.answerCallbackQuery();
		const jots = await this.getDeps().repo.recentJots(10);
		if (!jots.length)
			return ctx.editMessageText("No jots yet.", {
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
		const jot = id ? await this.getDeps().repo.getJot(id) : undefined;
		if (!jot)
			return ctx.editMessageText(`No jot ${id ?? ""}.`, {
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
		const deps = this.getDeps();
		if (!id || !(await deps.repo.getJot(id)))
			return void ctx.answerCallbackQuery({ text: "gone" });
		log.info({ jotId: id }, "menu: manual retry requested");
		await deps.repo.resetForRetry(id);
		deps.queue.add(id);
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
		const deps = this.getDeps();
		const jot = id ? await deps.repo.getJot(id) : undefined;
		if (!jot) return void ctx.answerCallbackQuery({ text: "gone" });
		// Answer before the note-lock read/write below, which can be slow enough to blow
		// past Telegram's callback-query window — the edited message carries the result.
		await ctx.answerCallbackQuery();
		log.info({ jotId: id }, "menu: delete jot");
		const msg = await this.deleteJot(jot);
		await ctx.editMessageText(msg, { reply_markup: this.backTo("menu:jots") });
	}

	/** Edit from the menu: send a force-reply prompt mapped to the jot, so the reply routes
	 *  through the normal reply-edit path (ScribaBot.handleEdit) with no new edit logic. */
	private async menuJotEdit(ctx: any, id?: string): Promise<void> {
		const deps = this.getDeps();
		if (!id || !(await deps.repo.getJot(id)))
			return void ctx.answerCallbackQuery({ text: "gone" });
		await ctx.answerCallbackQuery();
		log.info({ jotId: id }, "menu: edit jot — prompting for a reply");
		const sent = await this.bot.api.sendMessage(
			config.telegram.allowedUserId,
			`✏️ Reply to this message with your edit for ${id} (or "delete" to remove it).`,
		);
		await deps.repo.mapMessage(sent.message_id, id);
	}

	/** Failed queue as tappable retry rows. Reuses the existing `rt:` retry handler. */
	private async menuFailed(ctx: any): Promise<void> {
		await ctx.answerCallbackQuery();
		const jots = await this.getDeps().repo.failedJots(10);
		if (!jots.length)
			return ctx.editMessageText("✅ nothing failed.", {
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
