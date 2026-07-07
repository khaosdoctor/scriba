import { type Bot, InlineKeyboard } from "grammy";
import { config } from "../config.ts";
import type { Repository } from "../db.ts";
import { logger } from "../log.ts";
import type { ObsidianClient } from "../services/obsidian.ts";
import { DATE_RE, plainDate } from "../time.ts";

const log = logger("rating");

/** callback_query namespace this command owns (see ScribaBot.handleButton). */
export const RATING_NS = "rate";

/** Build the 1–10 rating keyboard for a given day; the date rides in the callback data
 *  so a tap works even days later and always lands on the right note. */
function ratingKeyboard(date: string): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (let n = 1; n <= 10; n++) {
		kb.text(String(n), `${RATING_NS}:${date}:${n}`);
		if (n === 5) kb.row();
	}
	return kb;
}

/** The daily "how was your day?" rating command: the /rate slash command, the nightly
 *  prompt, and the 1–10 button callback. A rating is write-once (DB gate) and sets the
 *  `overallRating` frontmatter of that day's note. */
export class RatingCommand {
	constructor(
		private bot: Bot,
		private repo: Repository,
		private obsidian: ObsidianClient,
	) {}

	/** Wire the /rate command. Callback taps are routed in from ScribaBot.handleButton. */
	register(): void {
		// Rate any day on demand: `/rate` → today, `/rate 2026-07-05` → that day.
		this.bot.command("rate", async (ctx) => {
			const arg = ctx.match.trim();
			log.info({ arg: arg || "(today)" }, "/rate command");
			if (arg && !DATE_RE.test(arg)) {
				log.warn({ arg }, "/rate rejected: bad date");
				return void ctx.reply("Usage: /rate or /rate YYYY-MM-DD");
			}
			await this.prompt(arg || plainDate());
		});
	}

	/** Ask "how was your day?" for `date` with a 1–10 button grid. Called nightly by the
	 *  scheduler and on demand by /rate. */
	async prompt(date: string): Promise<void> {
		log.info({ date }, "prompting for daily rating");
		await this.bot.api.sendMessage(
			config.telegram.allowedUserId,
			`📊 How was ${date}? Rate it 1–10:`,
			{ reply_markup: ratingKeyboard(date) },
		);
	}

	/** Handle a `rate:<date>:<n>` button tap. Write-once via the DB gate, then replace the
	 *  buttons with a confirmation so the day can't be rated twice. */
	async handleTap(ctx: any, date?: string, n?: string): Promise<void> {
		const rating = Number(n);
		log.debug({ date, n }, "rating button tapped");
		if (
			!date ||
			!DATE_RE.test(date) ||
			!Number.isInteger(rating) ||
			rating < 1 ||
			rating > 10
		) {
			log.warn({ date, n }, "rating tap rejected: bad payload");
			return void ctx.answerCallbackQuery({ text: "bad rating" });
		}
		const { recorded, current } = await this.repo.recordRating(date, rating);
		if (!recorded) {
			log.info(
				{ date, attempted: rating, current },
				"rating tap ignored: day already rated",
			);
			await ctx.answerCallbackQuery({ text: `already rated ${current}/10` });
			return void ctx.editMessageText(
				`📊 ${date} already rated ${current}/10.`,
			);
		}
		log.info({ date, rating }, "recorded rating, writing frontmatter");
		try {
			await this.obsidian.setDailyRating(date, rating);
		} catch (e) {
			log.error(
				{ err: e, date, rating },
				"frontmatter write failed, releasing rating for retry",
			);
			await this.repo.clearRating(date); // let the user try again
			throw e;
		}
		log.info({ date, rating }, "daily rating saved");
		await ctx.answerCallbackQuery({ text: `saved ${rating}/10` });
		await ctx.editMessageText(`📊 ${date} rated ${rating}/10`);
	}
}
