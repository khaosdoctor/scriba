import { type Bot, InlineKeyboard } from "grammy";
import { config } from "../../config.ts";
import { setFrontmatterValue } from "../../core.ts";
import { logger } from "../../log.ts";
import type { ObsidianClient } from "../../services/obsidian.ts";
import { DATE_RE, previousDate } from "../../time.ts";
import {
	completeHabitLine,
	isHabitsReviewed,
	isNumericValue,
	parseHabitRef,
	parseHabits,
} from "./parse.ts";

export { parseHabitRef } from "./parse.ts"; // bot.ts routes habit replies via this

const log = logger("habits");

/** callback_query namespace this command owns (see ScribaBot.handleButton). */
export const HABITS_NS = "hb";

/** The daily habit review: the /habits slash command, the nightly prompt, and the
 *  one-habit-at-a-time flow. Habits are the checklist under the `## Habits` heading of a
 *  day's note.
 *
 *  The review is a single Telegram message that gets edited in place through the whole flow:
 *  "Begin" starts it, each habit replaces the content with buttons (yes/no) or a reply
 *  prompt (value), and at the end the message is deleted and `habitsReviewed: true` is
 *  stamped in the note's frontmatter so a second run can't overwrite answers. */
export class HabitsCommand {
	/** The message id of the active review flow, keyed by date.
	 *  Only one review per date can be in progress at a time. */
	private activeMsg = new Map<string, number>();

	constructor(
		private bot: Bot,
		private obsidian: ObsidianClient,
	) {}

	/** Wire /habits. Callback taps and reply routing come in from ScribaBot. */
	register(): void {
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

	/** Start the review for `date`: send a single message with a "Begin" button.
	 *  Called nightly by the scheduler and on demand by /habits.
	 *  `announceEmpty` makes the manual command speak up when there's nothing to review. */
	async prompt(date: string, announceEmpty = false): Promise<void> {
		log.info({ date, announceEmpty }, "prompting for habit review");
		const daily = await this.obsidian.readDailyNote(date);

		if (daily && isHabitsReviewed(daily.content)) {
			log.info({ date }, "habits already reviewed — skipping");
			if (announceEmpty) {
				await this.bot.api.sendMessage(
					config.telegram.allowedUserId,
					`✅ Habits already reviewed for ${date}.`,
				);
			}
			return;
		}

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
		log.info({ date, count: pending.length }, "sending habit review prompt");
		const kb = new InlineKeyboard().text(
			"🌱 Begin",
			`${HABITS_NS}:${date}:begin`,
		);
		const sent = await this.bot.api.sendMessage(
			config.telegram.allowedUserId,
			`🌱 Time to review habits for ${date} — ${pending.length} to go.`,
			{ reply_markup: kb },
		);
		this.activeMsg.set(date, sent.message_id);
	}

	/** Ask about the next pending habit at or after `fromIndex` by editing the flow message.
	 *  When none remain, stamp `habitsReviewed` and delete the message. */
	private async ask(date: string, fromIndex: number): Promise<void> {
		const daily = await this.obsidian.readDailyNote(date);
		if (!daily) {
			log.warn({ date }, "note vanished mid-review — stopping");
			await this.cleanup(date);
			return;
		}
		const habit = parseHabits(
			daily.content,
			config.obsidian.habitsHeading,
		).find((h) => h.index >= fromIndex && !h.done);
		if (!habit) {
			log.info({ date }, "habit review complete — stamping frontmatter");
			await this.markReviewed(date, daily.path);
			await this.cleanup(date);
			return;
		}
		log.debug(
			{ date, index: habit.index, kind: habit.field ? "value" : "yes/no" },
			"asking habit",
		);
		const msgId = this.activeMsg.get(date);
		if (!msgId) {
			log.warn({ date }, "no active flow message — cannot continue");
			return;
		}
		if (habit.field) {
			const text = `🌱 ${habit.label}? Reply to this message with a number.\n(hb:${date}:${habit.index})`;
			await this.bot.api.editMessageText(
				config.telegram.allowedUserId,
				msgId,
				text,
			);
			return;
		}
		const kb = new InlineKeyboard()
			.text("✅ Yes", `${HABITS_NS}:${date}:${habit.index}:y`)
			.text("❌ No", `${HABITS_NS}:${date}:${habit.index}:n`);
		await this.bot.api.editMessageText(
			config.telegram.allowedUserId,
			msgId,
			`🌱 ${habit.label}?`,
			{ reply_markup: kb },
		);
	}

	/** Handle the "Begin" tap, or a Yes/No tap on a boolean habit. */
	async handleTap(
		ctx: any,
		date?: string,
		action?: string,
		verd?: string,
	): Promise<void> {
		log.debug({ date, action, verd }, "habit button tapped");
		if (!date || !DATE_RE.test(date)) {
			log.warn({ date, action, verd }, "habit tap rejected: bad payload");
			return void ctx.answerCallbackQuery({ text: "bad habit" });
		}

		if (action === "begin") {
			const msgId =
				ctx.callbackQuery?.message?.message_id ?? this.activeMsg.get(date);
			if (msgId) this.activeMsg.set(date, msgId);
			await ctx.answerCallbackQuery();
			return this.ask(date, 0);
		}

		const index = Number(action);
		if (!Number.isInteger(index)) {
			log.warn({ date, action, verd }, "habit tap rejected: bad index");
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
		} else {
			log.info({ date, index, label: habit.label }, "habit left unfulfilled");
		}
		await ctx.answerCallbackQuery();
		await this.ask(date, index + 1);
	}

	/** Handle a text reply to a value habit's question: validate numeric, fill the field,
	 *  mark done, advance. */
	async handleReply(ctx: any): Promise<void> {
		const ref = parseHabitRef(ctx.message.reply_to_message?.text ?? "");
		if (!ref) return;
		const value = ctx.message.text.trim();
		log.info({ date: ref.date, index: ref.index, value }, "habit value reply");
		if (!isNumericValue(value)) {
			log.warn({ date: ref.date, value }, "habit value rejected: not a number");
			await ctx.reply("That's not a number. Reply with a number only.");
			return;
		}
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
		// Delete the user's reply to keep the chat clean — the flow message shows progress.
		await this.bot.api
			.deleteMessage(ctx.chat.id, ctx.message.message_id)
			.catch(() => {});
		await this.ask(ref.date, ref.index + 1);
	}

	/** Stamp `habitsReviewed: true` in the note's frontmatter so a second run won't
	 *  overwrite answers. */
	private async markReviewed(date: string, path: string): Promise<void> {
		await this.obsidian.withNoteLock(path, async () => {
			const note = await this.obsidian.readNote(path);
			await this.obsidian.writeNote(
				path,
				setFrontmatterValue(note, "habitsReviewed", "true"),
			);
		});
		log.info({ date, path }, "habitsReviewed frontmatter set");
	}

	/** Delete the flow message and clear tracking state. */
	private async cleanup(date: string): Promise<void> {
		const msgId = this.activeMsg.get(date);
		if (msgId) {
			await this.bot.api
				.deleteMessage(config.telegram.allowedUserId, msgId)
				.catch(() => {});
			this.activeMsg.delete(date);
		}
	}
}
