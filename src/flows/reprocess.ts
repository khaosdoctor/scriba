import { type Bot, InlineKeyboard } from "grammy";
import { config } from "../config.ts";
import {
	jotPreview,
	monthGrid,
	pluralize,
	reprocessTargets,
	STATUS_ICON,
} from "../core.ts";
import type { Repository } from "../db.ts";
import { logger } from "../log.ts";
import type { FlushQueue } from "../runtime/queue.ts";
import { DATE_RE, dayBounds, plainDate } from "../time.ts";

const log = logger("reprocess");

/** callback_query namespace this command owns (see ScribaBot.handleButton). */
export const REPROCESS_NS = "rp";

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
const JOT_PAGE = 8;
const pad = (n: string | number) => String(n).padStart(2, "0");

/** The interactive /reprocess flow: rerun enrichment for jots already saved, replacing
 *  their journal line in place (same pipeline a new message goes through — reset to
 *  pending, then the normal queue/processor picks it up). Three entry points: a single
 *  day (calendar picker), a date range (calendar twice), or one jot (paged list). A
 *  squashed follower always resolves to its leader's id, since the leader carries the
 *  combined line. */
export class ReprocessCommand {
	private queue?: FlushQueue;

	constructor(
		private bot: Bot,
		private repo: Repository,
	) {}

	/** Wired after construction — the queue doesn't exist yet when ScribaBot builds this
	 *  (see ScribaBot.setQueue). */
	setQueue(queue: FlushQueue): void {
		this.queue = queue;
	}

	register(): void {
		this.bot.command("reprocess", async (ctx) => {
			log.info("reprocess menu opened");
			await ctx.reply("🔁 Reprocess — choose scope:", {
				reply_markup: this.rootMenu(),
			});
		});
	}

	/** Post a fresh scope-picker message. Used by /reprocess directly and by /menu's
	 *  "Reprocess" entry (which can't edit its own message into this multi-step flow). */
	async promptRoot(): Promise<void> {
		log.info("reprocess menu opened (via /menu)");
		await this.bot.api.sendMessage(
			config.telegram.allowedUserId,
			"🔁 Reprocess — choose scope:",
			{ reply_markup: this.rootMenu() },
		);
	}

	private rootMenu(): InlineKeyboard {
		return new InlineKeyboard()
			.text("📅 One day", `${REPROCESS_NS}:day`)
			.row()
			.text("📆 Date range", `${REPROCESS_NS}:range`)
			.row()
			.text("✉️ One jot", `${REPROCESS_NS}:jot:0`);
	}

	private backTo(target: string): InlineKeyboard {
		return new InlineKeyboard().text("‹ Back", target);
	}

	/** Dispatch a `rp:<action>[:<args>]` callback. */
	async handleTap(ctx: any, rest: string[]): Promise<void> {
		const [action, ...args] = rest;
		switch (action) {
			case "root":
				await ctx.answerCallbackQuery();
				return void ctx.editMessageText("🔁 Reprocess — choose scope:", {
					reply_markup: this.rootMenu(),
				});
			case "noop":
				return void ctx.answerCallbackQuery();
			case "day":
				return args.length >= 3
					? this.confirmDay(ctx, `${args[0]}-${pad(args[1]!)}-${pad(args[2]!)}`)
					: this.renderDayCalendar(ctx, args[0], args[1]);
			case "range":
				return args.length >= 3
					? this.pickRangeStart(ctx, args)
					: this.renderRangeStartCalendar(ctx, args[0], args[1]);
			case "rangeend":
				return args.length >= 4
					? this.pickRangeEnd(ctx, args)
					: this.renderRangeEndCalendar(ctx, args);
			case "jot":
				// A crafted/stale button could carry a negative page — clamp rather than
				// pass it through to jotsPage()'s offset.
				return this.showJotPage(ctx, Math.max(0, Number(args[0]) || 0));
			case "jotpick":
				return this.confirmJot(ctx, args[0]);
			case "go":
				return this.execute(ctx, args);
			case "cancel":
				await ctx.answerCallbackQuery();
				return void ctx.editMessageText("Cancelled.");
			default:
				log.warn({ action }, "reprocess: unknown action");
				await ctx.answerCallbackQuery();
		}
	}

	/** Parse year/month callback args into a valid pair, falling back to the current month
	 *  for anything missing, non-numeric, or outside 1-12 (a stale/crafted callback) —
	 *  otherwise an out-of-range month renders a mislabeled calendar, or (month NaN) makes
	 *  monthGrid's `Array(startDow)` throw outright. */
	private parseYearMonth(
		y?: string,
		m?: string,
	): { year: number; month: number } {
		const now = new Date();
		const year = Number(y);
		const month = Number(m);
		return {
			year: Number.isInteger(year) && year > 0 ? year : now.getFullYear(),
			month:
				Number.isInteger(month) && month >= 1 && month <= 12
					? month
					: now.getMonth() + 1,
		};
	}

	/** Prev/next month for calendar nav, wrapping across year boundaries. */
	private monthNav(year: number, month: number) {
		return {
			py: month === 1 ? year - 1 : year,
			pm: month === 1 ? 12 : month - 1,
			ny: month === 12 ? year + 1 : year,
			nm: month === 12 ? 1 : month + 1,
		};
	}

	/** Build a calendar keyboard for year/month. `dayCb`/`navCb` produce the callback data
	 *  for a day tap / month-nav tap, so day-pick and range-end-pick (which must carry the
	 *  range start along) can share this renderer. */
	private buildCalendar(
		year: number,
		month: number,
		dayCb: (day: number) => string,
		navCb: (year: number, month: number) => string,
	): InlineKeyboard {
		const kb = new InlineKeyboard();
		for (const label of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"])
			kb.text(label, `${REPROCESS_NS}:noop`);
		kb.row();
		for (const week of monthGrid(year, month)) {
			for (const day of week) {
				if (day === 0) kb.text(" ", `${REPROCESS_NS}:noop`);
				else kb.text(String(day), dayCb(day));
			}
			kb.row();
		}
		const { py, pm, ny, nm } = this.monthNav(year, month);
		kb.text("‹", navCb(py, pm)).text("›", navCb(ny, nm)).row();
		kb.text("‹ Back", `${REPROCESS_NS}:root`);
		return kb;
	}

	private async renderDayCalendar(
		ctx: any,
		y?: string,
		m?: string,
	): Promise<void> {
		await ctx.answerCallbackQuery();
		const { year, month } = this.parseYearMonth(y, m);
		const kb = this.buildCalendar(
			year,
			month,
			(d) => `${REPROCESS_NS}:day:${year}:${month}:${d}`,
			(yy, mm) => `${REPROCESS_NS}:day:${yy}:${mm}`,
		);
		await ctx.editMessageText(
			`📅 Pick a day to reprocess (${MONTHS[month - 1]} ${year}):`,
			{ reply_markup: kb },
		);
	}

	private async confirmDay(ctx: any, date: string): Promise<void> {
		// dayBounds throws on anything that isn't YYYY-MM-DD — guard a stale/crafted
		// callback rather than let it fall through to the generic error handler.
		if (!DATE_RE.test(date)) {
			log.warn({ date }, "reprocess: day tap rejected: bad date");
			return void ctx.answerCallbackQuery({ text: "bad date" });
		}
		await ctx.answerCallbackQuery();
		const [from, to] = dayBounds(date);
		const targets = reprocessTargets(await this.repo.jotsInRange(from, to));
		if (!targets.length) {
			return void ctx.editMessageText(`No reprocessable jots on ${date}.`, {
				reply_markup: this.backTo(`${REPROCESS_NS}:root`),
			});
		}
		const kb = new InlineKeyboard()
			.text(
				`🔁 Yes, reprocess ${pluralize(targets.length, "jot")}`,
				`${REPROCESS_NS}:go:d:${date}`,
			)
			.row()
			.text("Cancel", `${REPROCESS_NS}:cancel`);
		await ctx.editMessageText(
			`Reprocess ${pluralize(targets.length, "jot")} from ${date}?`,
			{ reply_markup: kb },
		);
	}

	private async renderRangeStartCalendar(
		ctx: any,
		y?: string,
		m?: string,
	): Promise<void> {
		await ctx.answerCallbackQuery();
		const { year, month } = this.parseYearMonth(y, m);
		const kb = this.buildCalendar(
			year,
			month,
			(d) => `${REPROCESS_NS}:range:${year}:${month}:${d}`,
			(yy, mm) => `${REPROCESS_NS}:range:${yy}:${mm}`,
		);
		await ctx.editMessageText(
			`📆 Pick the range start (${MONTHS[month - 1]} ${year}):`,
			{ reply_markup: kb },
		);
	}

	private async pickRangeStart(ctx: any, args: string[]): Promise<void> {
		const [y, m, d] = args;
		const start = `${y}-${pad(m!)}-${pad(d!)}`;
		await ctx.answerCallbackQuery();
		// This next calendar's own year/month, not `start` (validated later in
		// pickRangeEnd) — normalize so a stale/crafted callback can't crash monthGrid.
		const { year, month } = this.parseYearMonth(y, m);
		const kb = this.buildCalendar(
			year,
			month,
			(day) => `${REPROCESS_NS}:rangeend:${start}:${year}:${month}:${day}`,
			(yy, mm) => `${REPROCESS_NS}:rangeend:${start}:${yy}:${mm}`,
		);
		await ctx.editMessageText(
			`📆 Start: ${start}. Now pick the range end (${MONTHS[month - 1]} ${year}):`,
			{ reply_markup: kb },
		);
	}

	private async renderRangeEndCalendar(
		ctx: any,
		args: string[],
	): Promise<void> {
		const [start, y, m] = args;
		await ctx.answerCallbackQuery();
		const { year, month } = this.parseYearMonth(y, m);
		const kb = this.buildCalendar(
			year,
			month,
			(day) => `${REPROCESS_NS}:rangeend:${start}:${year}:${month}:${day}`,
			(yy, mm) => `${REPROCESS_NS}:rangeend:${start}:${yy}:${mm}`,
		);
		await ctx.editMessageText(
			`📆 Start: ${start}. Pick the range end (${MONTHS[month - 1]} ${year}):`,
			{ reply_markup: kb },
		);
	}

	private async pickRangeEnd(ctx: any, args: string[]): Promise<void> {
		const [start, y, m, d] = args;
		const end = `${y}-${pad(m!)}-${pad(d!)}`;
		// dayBounds throws on anything that isn't YYYY-MM-DD — guard a stale/crafted
		// callback (e.g. a range-start carried over from before a code change) rather than
		// let it fall through to the generic error handler.
		if (!DATE_RE.test(start ?? "") || !DATE_RE.test(end)) {
			log.warn({ start, end }, "reprocess: range-end tap rejected: bad date");
			return void ctx.answerCallbackQuery({ text: "bad date" });
		}
		await ctx.answerCallbackQuery();
		// Picking the end before the start (backwards range) just swaps rather than erroring.
		const [lo, hi] = start! <= end ? [start!, end] : [end, start!];
		const [from] = dayBounds(lo);
		const [, to] = dayBounds(hi);
		const targets = reprocessTargets(await this.repo.jotsInRange(from, to));
		if (!targets.length) {
			return void ctx.editMessageText(
				`No reprocessable jots between ${lo} and ${hi}.`,
				{ reply_markup: this.backTo(`${REPROCESS_NS}:root`) },
			);
		}
		const kb = new InlineKeyboard()
			.text(
				`🔁 Yes, reprocess ${pluralize(targets.length, "jot")}`,
				`${REPROCESS_NS}:go:r:${lo}:${hi}`,
			)
			.row()
			.text("Cancel", `${REPROCESS_NS}:cancel`);
		await ctx.editMessageText(
			`Reprocess ${pluralize(targets.length, "jot")} from ${lo} to ${hi}?`,
			{ reply_markup: kb },
		);
	}

	private async showJotPage(ctx: any, page: number): Promise<void> {
		await ctx.answerCallbackQuery();
		// Fetch one extra row to know whether a "Next" page exists, without a count query.
		const rows = await this.repo.jotsPage(page * JOT_PAGE, JOT_PAGE + 1);
		const hasNext = rows.length > JOT_PAGE;
		const shown = rows.slice(0, JOT_PAGE);
		if (!shown.length) {
			return void ctx.editMessageText(
				page === 0 ? "No reprocessable jots yet." : "No more jots.",
				{ reply_markup: this.backTo(`${REPROCESS_NS}:root`) },
			);
		}
		const kb = new InlineKeyboard();
		for (const j of shown) {
			const label =
				`${STATUS_ICON[j.status]} ${plainDate(j.received_at)} ${j.time} ${jotPreview(j)}`.slice(
					0,
					64,
				);
			kb.text(label, `${REPROCESS_NS}:jotpick:${j.id}`).row();
		}
		if (page > 0) kb.text("‹ Prev", `${REPROCESS_NS}:jot:${page - 1}`);
		if (hasNext) kb.text("Next ›", `${REPROCESS_NS}:jot:${page + 1}`);
		if (page > 0 || hasNext) kb.row();
		kb.text("‹ Back", `${REPROCESS_NS}:root`);
		await ctx.editMessageText(
			`✉️ Pick a jot to reprocess${page ? ` (page ${page + 1})` : ""}:`,
			{ reply_markup: kb },
		);
	}

	private async confirmJot(ctx: any, id?: string): Promise<void> {
		const jot = id ? await this.repo.getJot(id) : undefined;
		if (!jot) return void ctx.answerCallbackQuery({ text: "gone" });
		await ctx.answerCallbackQuery();
		const leaderId = jot.anchor; // a squashed follower reprocesses via its leader's line
		const note =
			leaderId === jot.id
				? ""
				: "\n(part of a squashed entry — this reprocesses the whole line)";
		const kb = new InlineKeyboard()
			.text("🔁 Yes, reprocess", `${REPROCESS_NS}:go:j:${leaderId}`)
			.row()
			.text("Cancel", `${REPROCESS_NS}:cancel`);
		await ctx.editMessageText(`Reprocess "${jotPreview(jot, 80)}"?${note}`, {
			reply_markup: kb,
		});
	}

	private async execute(ctx: any, args: string[]): Promise<void> {
		const [mode, ...rest] = args;
		let targets: string[];
		let label: string;
		// dayBounds throws on anything that isn't YYYY-MM-DD — guard a stale/crafted "go"
		// callback the same way the calendar taps upstream of it already are.
		if (mode === "d") {
			const [date] = rest;
			if (!DATE_RE.test(date ?? "")) {
				log.warn({ date }, "reprocess: execute rejected: bad date");
				return void ctx.answerCallbackQuery({ text: "bad date" });
			}
			const [from, to] = dayBounds(date!);
			targets = reprocessTargets(await this.repo.jotsInRange(from, to));
			label = date!;
		} else if (mode === "r") {
			const [start, end] = rest;
			if (!DATE_RE.test(start ?? "") || !DATE_RE.test(end ?? "")) {
				log.warn({ start, end }, "reprocess: execute rejected: bad date");
				return void ctx.answerCallbackQuery({ text: "bad date" });
			}
			const [from] = dayBounds(start!);
			const [, to] = dayBounds(end!);
			targets = reprocessTargets(await this.repo.jotsInRange(from, to));
			label = `${start} → ${end}`;
		} else if (mode === "j") {
			const [id] = rest;
			if (!id) {
				log.warn("reprocess: execute rejected: missing jot id");
				return void ctx.answerCallbackQuery({ text: "bad jot id" });
			}
			targets = [id];
			label = id;
		} else {
			return void ctx.answerCallbackQuery();
		}
		if (!targets.length) {
			await ctx.answerCallbackQuery({ text: "nothing to reprocess" });
			return void ctx.editMessageText(`No reprocessable jots for ${label}.`, {
				reply_markup: this.backTo(`${REPROCESS_NS}:root`),
			});
		}
		// Guard explicitly rather than optional-chaining the enqueue away: without a queue
		// to pick them up, resetForReprocess would flip these jots to `pending` and strand
		// them there until the next retry sweep — a silent, hard-to-notice stuck state.
		const queue = this.queue;
		if (!queue) {
			log.error(
				{ mode, label, count: targets.length },
				"reprocess: queue not wired — refusing to reset jots to pending",
			);
			await ctx.answerCallbackQuery({ text: "internal error" });
			return void ctx.editMessageText(
				"⚠️ Reprocess isn't ready yet — try again in a moment.",
				{ reply_markup: this.backTo(`${REPROCESS_NS}:root`) },
			);
		}
		log.info(
			{ mode, label, count: targets.length, ids: targets },
			"reprocess triggered",
		);
		// Only enqueue what was actually flipped to pending — a target can lose eligibility
		// between the query above and this reset (raced to `processing`, or a stale/crafted
		// callback), and enqueueing it anyway would just be a no-op with a misleading count.
		const reset = await this.repo.resetForReprocess(targets);
		if (!reset.length) {
			await ctx.answerCallbackQuery({ text: "nothing to reprocess" });
			return void ctx.editMessageText(
				`No reprocessable jots for ${label} anymore.`,
				{ reply_markup: this.backTo(`${REPROCESS_NS}:root`) },
			);
		}
		for (const id of reset) queue.add(id);
		await ctx.answerCallbackQuery({ text: "reprocessing…" });
		await ctx.editMessageText(
			`🔁 Reprocessing ${pluralize(reset.length, "jot")} from ${label}…`,
		);
	}
}
