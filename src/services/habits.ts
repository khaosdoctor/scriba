import type { ObsidianClient } from "../data/repositories/notes.ts";
import type { Habit } from "../domain/habit/entity.ts";
import {
  completeHabitLine,
  isHabitsReviewed,
  isNumericValue,
  parseHabits,
} from "../libs/habits.ts";
import { logger } from "../libs/log.ts";
import type { Notifier } from "./notifier.ts";

const log = logger("habits");

/** callback_query namespace of the review card's buttons. */
export const HABITS_NS = "hb";

export interface HabitDeps {
  obsidian: Pick<
    ObsidianClient,
    "readDailyNote" | "updateNote" | "setFrontmatter"
  >;
  notifier: Pick<Notifier, "notify" | "send" | "edit" | "delete">;
  heading: string;
}

export type FillOutcome = "saved" | "notNumber" | "gone";

/** The daily habit review: one Telegram message, edited in place through the whole flow
 *  and deleted at the end, when `habitsReviewed: true` is stamped in the note's frontmatter
 *  so a second run can't overwrite answers. */
export class HabitController {
  /** The flow message of each date being reviewed. Forgotten on restart. */
  private activeMsg = new Map<string, number>();

  constructor(private deps: HabitDeps) {}

  /** `announceEmpty` makes a manual review speak up when there is nothing to ask. */
  async prompt(date: string, announceEmpty = false): Promise<void> {
    const { obsidian, notifier, heading } = this.deps;
    const say = async (text: string) => {
      if (announceEmpty) await notifier.notify(text);
    };
    const daily = await obsidian.readDailyNote(date);
    if (daily && isHabitsReviewed(daily.content)) {
      log.info({ date }, `habits already reviewed — skipping`);
      return say(`✅ Habits already reviewed for ${date}.`);
    }
    const pending = daily
      ? parseHabits(daily.content, heading).filter((h) => !h.done)
      : [];
    if (!pending.length) {
      log.info({ date, hasNote: !!daily }, "no pending habits to review");
      return say(
        daily
          ? `✅ All habits already done for ${date}.`
          : `No habits found for ${date}.`,
      );
    }
    log.info({ date, count: pending.length }, "sending habit review prompt");
    const id = await notifier.send(
      `🌱 Time to review habits for ${date} — ${pending.length} to go.`,
      {
        keyboard: {
          inline_keyboard: [
            [{ text: "🌱 Begin", callback_data: `${HABITS_NS}:${date}:begin` }],
          ],
        },
      },
    );
    this.activeMsg.set(date, id);
  }

  /** Ask about the next pending habit at or after `fromIndex` by editing the flow message,
   *  which is `card` when the tapped Begin card is not the one sent before a restart. When
   *  none remain, stamp `habitsReviewed` and delete the message. */
  async ask(date: string, fromIndex: number, card?: number): Promise<void> {
    const { obsidian, notifier, heading } = this.deps;
    if (card) this.activeMsg.set(date, card);
    const daily = await obsidian.readDailyNote(date);
    if (!daily) {
      log.warn({ date }, `note vanished mid-review — stopping`);
      return this.cleanup(date);
    }
    const habit = parseHabits(daily.content, heading).find(
      (h) => h.index >= fromIndex && !h.done,
    );
    if (!habit) {
      log.info({ date }, `habit review complete — stamping frontmatter`);
      await obsidian.setFrontmatter(daily.path, "habitsReviewed", "true");
      return this.cleanup(date);
    }
    const msgId = this.activeMsg.get(date);
    if (!msgId) {
      log.warn({ date }, `no active flow message — cannot continue`);
      return;
    }
    if (habit.field)
      return notifier.edit(
        msgId,
        `🌱 ${habit.label}? Reply to this message with a number.\n(hb:${date}:${habit.index})`,
      );
    const button = (text: string, verdict: string) => ({
      text,
      callback_data: `${HABITS_NS}:${date}:${habit.index}:${verdict}`,
    });
    await notifier.edit(msgId, `🌱 ${habit.label}?`, {
      keyboard: {
        inline_keyboard: [[button("✅ Yes", "y"), button("❌ No", "n")]],
      },
    });
  }

  /** Record a Yes or No on habit `index`. False when the note or the habit is gone. */
  async tap(date: string, index: number, done: boolean): Promise<boolean> {
    const found = await this.find(date, index);
    if (!found) {
      log.warn({ date, index }, "habit tap ignored: note or habit gone");
      return false;
    }
    if (done) await this.tick(found.path, found.habit, date);
    log.info(
      { date, index, label: found.habit.label },
      done ? "habit marked done" : "habit left unfulfilled",
    );
    return true;
  }

  async fill(date: string, index: number, value: string): Promise<FillOutcome> {
    if (!isNumericValue(value)) {
      log.warn({ date, value }, "habit value rejected: not a number");
      return "notNumber";
    }
    const found = await this.find(date, index);
    if (!found) {
      log.warn(
        { date, index },
        "habit value reply ignored: note or habit gone",
      );
      return "gone";
    }
    await this.tick(found.path, found.habit, date, value);
    log.info({ date, index, label: found.habit.label }, "habit value recorded");
    return "saved";
  }

  private async find(date: string, index: number) {
    const daily = await this.deps.obsidian.readDailyNote(date);
    const habit =
      daily &&
      parseHabits(daily.content, this.deps.heading).find(
        (h) => h.index === index,
      );
    return daily && habit ? { path: daily.path, habit } : null;
  }

  private tick(path: string, habit: Habit, date: string, value?: string) {
    const updated = completeHabitLine(habit.line, date, value);
    return this.deps.obsidian.updateNote(path, (note, write) =>
      write(note.replace(habit.line, () => updated)),
    );
  }

  private async cleanup(date: string): Promise<void> {
    const msgId = this.activeMsg.get(date);
    if (!msgId) return;
    await this.deps.notifier.delete(msgId).catch(() => {});
    this.activeMsg.delete(date);
  }
}
