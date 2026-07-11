import { type Bot, InlineKeyboard } from "grammy";
import { commands, type Deps } from "../commands/index.ts";
import { config } from "../config.ts";
import { formatJotDetail, jotPreview, STATUS_ICON } from "../core.ts";
import type { Jot } from "../db.ts";
import { logger } from "../log.ts";
import { plainDate } from "../time.ts";
import type { HabitsCommand } from "./habits/index.ts";
import type { RatingCommand } from "./rating.ts";
import type { ReprocessCommand } from "./reprocess.ts";

const log = logger("menu");

/** The interactive /menu control panel — a callback-driven entry point layered over the
 *  slash commands, not a replacement. Every leaf reuses an existing command (via runCmd)
 *  or flow (rating/habits/reprocess prompts, jot edit/delete), so the menu adds an entry
 *  point but no new business logic. `getDeps` is lazy (mirrors ScribaBot.deps()) since the
 *  queue and processor aren't wired up yet when this class is constructed. */
export class MenuController {
	// Rejected-links menu page size (rows per page).
	private static readonly REJECT_PAGE = 8;
	// chatId -> message id of the last root menu in that chat, so opening a fresh /menu
	// retires the old one instead of leaving stale, still-tappable keyboards piling up.
	// Keyed by chat (not a single field) since message ids are only unique per chat — the
	// allowed user can open /menu from more than one chat (e.g. a group, then a DM).
	private lastMenuMsgId = new Map<number, number>();

	constructor(
		private bot: Bot,
		private rating: RatingCommand,
		private habits: HabitsCommand,
		private reprocess: ReprocessCommand,
		private getDeps: () => Deps,
		private deleteJot: (jot: Jot) => Promise<string>,
	) {}

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
			await ctx.api.deleteMessage(ctx.chat.id, prev).catch(() => {});
		}
		const sent = await ctx.reply("🗂 scriba control menu", {
			reply_markup: this.rootMenu(),
		});
		this.lastMenuMsgId.set(ctx.chat.id, sent.message_id);
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
			.text(`🎙 Transcriber: ${this.getDeps().transcriber.mode}`, "menu:tx")
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
		const out = await cmd.run(ctx, arg, this.getDeps());
		return typeof out === "string" ? out : "";
	}

	/** Dispatch a `menu:<action>[:<arg>]` callback. Routed in from ScribaBot.handleButton. */
	async handleCallback(ctx: any, rest: string[]): Promise<void> {
		const [action, arg] = rest;
		switch (action) {
			case "root":
				await ctx.answerCallbackQuery();
				return ctx.editMessageText("🗂 scriba control menu", {
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
				return ctx.editMessageText("🛠 Maintenance", {
					reply_markup: this.maintMenu(),
				});
			case "links":
				await ctx.answerCallbackQuery();
				return ctx.editMessageText("🔗 Link rules", {
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
		const PAGE = MenuController.REJECT_PAGE;
		const list = await this.getDeps().repo.rejectionList();
		if (!list.length)
			return ctx.editMessageText("No rejected links.", {
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
		const list = await this.getDeps().repo.rejectionList();
		const gi = arg === undefined ? -1 : Number(arg);
		const r = list[gi];
		if (!r) {
			log.warn({ arg }, "menu: reject index out of range");
			return void ctx.answerCallbackQuery({ text: "expired" });
		}
		// Answer before the write below, so a slow DB round-trip can't outlive Telegram's
		// callback-query window — the re-rendered page carries the result.
		await ctx.answerCallbackQuery();
		const n = await this.getDeps().repo.unreject(r.surface, r.note);
		log.info(
			{ surface: r.surface, note: r.note, removed: n },
			"unreject via menu",
		);
		return this.renderRejections(
			ctx,
			Math.floor(gi / MenuController.REJECT_PAGE),
		);
	}

	/** Close the menu — the control panel is transient, not part of the journal. */
	private async menuClose(ctx: any): Promise<void> {
		log.info("menu closed");
		await ctx.answerCallbackQuery();
		this.lastMenuMsgId.delete(ctx.chat.id);
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
			{
				reply_markup: {
					force_reply: true,
					input_field_placeholder: "your edit…",
				},
			},
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
