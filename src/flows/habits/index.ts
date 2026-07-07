import { type Bot, InlineKeyboard } from "grammy";
import { config } from "../../config.ts";
import { logger } from "../../log.ts";
import type { ObsidianClient } from "../../services/obsidian.ts";
import { DATE_RE, previousDate } from "../../time.ts";
import { completeHabitLine, parseHabitRef, parseHabits } from "./parse.ts";

export { parseHabitRef } from "./parse.ts"; // bot.ts routes habit replies via this

const log = logger("habits");

/** callback_query namespace this command owns (see ScribaBot.handleButton). */
export const HABITS_NS = "hb";

/** The daily habit review: the /habits slash command, the nightly prompt, and the
 *  one-habit-at-a-time flow. Habits are the checklist under the `## Habits` heading of a
 *  day's note. A yes/no habit is a Yes/No button tap; a habit with an inline `[key:: value]`
 *  field asks for a value via a text reply. Either way the answer ticks the box and stamps
 *  `[completion:: date]`. The day rides in the callback data / reply marker — never the DB —
 *  so a habit can be answered days later and always lands on the right note. */
export class HabitsCommand {
	constructor(
		private bot: Bot,
		private obsidian: ObsidianClient,
	) {}

	/** Wire /habits. Callback taps and reply routing come in from ScribaBot. */
	register(): void {
		// Review any day on demand: `/habits` → yesterday, `/habits 2026-07-05` → that day.
		this.bot.command("habits", async (ctx) => {
			const arg = ctx.match.trim();
			log.info({ arg: arg || "(yesterday)" }, "/habits command");
			if (arg && !DATE_RE.test(arg)) {
				log.warn({ arg }, "/habits rejected: bad date");
				return void ctx.reply("Usage: /habits or /habits YYYY-MM-DD");
			}
			await this.prompt(arg || previousDate(), true);
		});
	}

	/** Start the review for `date`: ask about its first pending habit (a single message that
	 *  kicks off the flow). Called nightly by the scheduler and on demand by /habits.
	 *  `announceEmpty` makes the manual command speak up when there's nothing to review. */
	async prompt(date: string, announceEmpty = false): Promise<void> {
		log.info({ date, announceEmpty }, "prompting for habit review");
		const daily = await this.obsidian.readDailyNote(date);
		const pending = daily
			? parseHabits(daily.content, config.obsidian.habitsHeading).filter(
					(h) => !h.done,
				)
			: [];
		if (!pending.length) {
			log.info({ date, hasNote: !!daily }, "no pending habits to review");
			if (announceEmpty) {
				await this.bot.api.sendMessage(
					config.telegram.allowedUserId,
					daily
						? `✅ All habits already done for ${date}.`
						: `No habits found for ${date}.`,
				);
			}
			return;
		}
		log.info({ date, count: pending.length }, "starting habit review");
		await this.ask(
			date,
			0,
			`🌱 Habits for ${date} — ${pending.length} to review:`,
		);
	}

	/** Ask about the next pending habit at or after `fromIndex`. Yes/no → buttons; value habit
	 *  → force-reply. When none remain, close the flow. `header` prefixes the first question. */
	private async ask(
		date: string,
		fromIndex: number,
		header = "",
	): Promise<void> {
		const daily = await this.obsidian.readDailyNote(date);
		if (!daily) {
			log.warn({ date }, "note vanished mid-review — stopping");
			return;
		}
		const habit = parseHabits(
			daily.content,
			config.obsidian.habitsHeading,
		).find((h) => h.index >= fromIndex && !h.done);
		if (!habit) {
			log.info({ date }, "habit review complete");
			await this.bot.api.sendMessage(
				config.telegram.allowedUserId,
				`✅ Habits reviewed for ${date}.`,
			);
			return;
		}
		log.debug(
			{ date, index: habit.index, kind: habit.field ? "value" : "yes/no" },
			"asking habit",
		);
		const lead = header ? `${header}\n\n` : "";
		if (habit.field) {
			// Value habit: the reply's text carries the answer; the marker routes it back.
			await this.bot.api.sendMessage(
				config.telegram.allowedUserId,
				`${lead}🌱 ${habit.label}? Reply with a value.\n(hb:${date}:${habit.index})`,
				{ reply_markup: { force_reply: true } },
			);
			return;
		}
		const kb = new InlineKeyboard()
			.text("✅ Yes", `${HABITS_NS}:${date}:${habit.index}:y`)
			.text("❌ No", `${HABITS_NS}:${date}:${habit.index}:n`);
		await this.bot.api.sendMessage(
			config.telegram.allowedUserId,
			`${lead}🌱 ${habit.label}?`,
			{ reply_markup: kb },
		);
	}

	/** Handle a Yes/No tap on a boolean habit, then advance to the next one. */
	async handleTap(
		ctx: any,
		date?: string,
		idxStr?: string,
		verd?: string,
	): Promise<void> {
		const index = Number(idxStr);
		log.debug({ date, idxStr, verd }, "habit button tapped");
		if (!date || !DATE_RE.test(date) || !Number.isInteger(index)) {
			log.warn({ date, idxStr, verd }, "habit tap rejected: bad payload");
			return void ctx.answerCallbackQuery({ text: "bad habit" });
		}
		const daily = await this.obsidian.readDailyNote(date);
		const habit =
			daily &&
			parseHabits(daily.content, config.obsidian.habitsHeading).find(
				(h) => h.index === index,
			);
		if (!daily || !habit) {
			log.warn({ date, index }, "habit tap ignored: note or habit gone");
			return void ctx.answerCallbackQuery({ text: "gone" });
		}
		if (verd === "y") {
			const updated = completeHabitLine(habit.line, date);
			await this.obsidian.writeNote(
				daily.path,
				daily.content.replace(habit.line, () => updated),
			);
			log.info({ date, index, label: habit.label }, "habit marked done");
			await ctx.editMessageText(`✅ ${habit.label}`);
		} else {
			log.info({ date, index, label: habit.label }, "habit left unfulfilled");
			await ctx.editMessageText(`❌ ${habit.label}`);
		}
		await ctx.answerCallbackQuery();
		await this.ask(date, index + 1);
	}

	/** Handle a text reply to a value habit's question: fill the field, mark done, advance. */
	async handleReply(ctx: any): Promise<void> {
		const ref = parseHabitRef(ctx.message.reply_to_message?.text ?? "");
		if (!ref) return; // not a habit reply — caller already checked, but stay defensive
		const value = ctx.message.text.trim();
		log.info({ date: ref.date, index: ref.index }, "habit value reply");
		const daily = await this.obsidian.readDailyNote(ref.date);
		const habit =
			daily &&
			parseHabits(daily.content, config.obsidian.habitsHeading).find(
				(h) => h.index === ref.index,
			);
		if (!daily || !habit) {
			log.warn(
				{ date: ref.date, index: ref.index },
				"habit value reply ignored: note or habit gone",
			);
			return void ctx.reply("Couldn't find that habit to update.");
		}
		const updated = completeHabitLine(habit.line, ref.date, value);
		await this.obsidian.writeNote(
			daily.path,
			daily.content.replace(habit.line, () => updated),
		);
		log.info(
			{ date: ref.date, index: ref.index, label: habit.label },
			"habit value recorded",
		);
		await ctx.reply(`✅ ${habit.label}: ${value}`);
		await this.ask(ref.date, ref.index + 1);
	}
}
