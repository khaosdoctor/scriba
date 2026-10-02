import type { ObsidianClient } from "../data/repositories/notes.ts";
import type { Habit } from "../domain/habit/entity.ts";
import {
  completeHabitLine,
  isHabitsReviewed,
  isNumericValue,
  parseHabits,
} from "../libs/habits.ts";
import { logger } from "../libs/log.ts";
import { fingerprint } from "../libs/tasks.ts";
import type { Notifier } from "./notifier.ts";

const log = logger("habits");

export const HABITS_NS = "hb";

export interface HabitDeps {
  obsidian: ObsidianClient;
  notifier: Pick<Notifier, "notify" | "send" | "edit" | "delete">;
  heading: string;
}

export type FillOutcome = "saved" | "notNumber" | "gone";

export class HabitService {
  private activeMsg = new Map<string, number>();

  constructor(private deps: HabitDeps) {}

  async prompt(date: string, announceEmpty = false): Promise<void> {
    const { obsidian, notifier, heading } = this.deps;
    const say = async (text: string) => {
      if (announceEmpty) await notifier.notify(text);
    };
    log.info({ date, announceEmpty }, "prompting for habit review");
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
      log.info({ date, path: daily.path }, "habitsReviewed frontmatter set");
      return this.cleanup(date);
    }
    log.debug(
      { date, index: habit.index, kind: habit.field ? "value" : "yes/no" },
      "asking habit",
    );
    const msgId = this.activeMsg.get(date);
    if (!msgId) {
      log.warn({ date }, `no active flow message — cannot continue`);
      return;
    }
    const digest = fingerprint(habit.line);
    if (habit.field)
      return notifier.edit(
        msgId,
        `🌱 ${habit.label}? Reply to this message with a number.\n(hb:${date}:${habit.index}:${digest})`,
      );
    const button = (text: string, verdict: string) => ({
      text,
      callback_data: `${HABITS_NS}:${date}:${habit.index}:${digest}:${verdict}`,
    });
    await notifier.edit(msgId, `🌱 ${habit.label}?`, {
      keyboard: {
        inline_keyboard: [[button("✅ Yes", "y"), button("❌ No", "n")]],
      },
    });
  }

  async tap(
    date: string,
    index: number,
    digest: string,
    done: boolean,
  ): Promise<boolean> {
    const habit = done
      ? await this.tick(date, index, digest)
      : await this.find(date, index, digest);
    if (!habit) {
      log.warn({ date, index }, "habit tap ignored: note or habit gone");
      return false;
    }
    log.info(
      { date, index, label: habit.label },
      done ? "habit marked done" : "habit left unfulfilled",
    );
    return true;
  }

  async fill(
    date: string,
    index: number,
    digest: string,
    value: string,
  ): Promise<FillOutcome> {
    log.info({ date, index, value }, "habit value reply");
    if (!isNumericValue(value)) {
      log.warn({ date, value }, "habit value rejected: not a number");
      return "notNumber";
    }
    const habit = await this.tick(date, index, digest, value);
    if (!habit) {
      log.warn(
        { date, index },
        "habit value reply ignored: note or habit gone",
      );
      return "gone";
    }
    log.info({ date, index, label: habit.label }, "habit value recorded");
    return "saved";
  }

  private async find(
    date: string,
    index: number,
    digest: string,
  ): Promise<Habit | null> {
    const daily = await this.deps.obsidian.readDailyNote(date);
    return daily ? this.habitAt(daily.content, index, digest) : null;
  }

  /** Tick habit `index`, locating its line in the note as it reads under the lock, so the
   *  line replaced is the live one: a habit edited or removed since the question was asked
   *  is reported gone instead of silently skipped. Null when the habit is gone. */
  private async tick(
    date: string,
    index: number,
    digest: string,
    value?: string,
  ): Promise<Habit | null> {
    const { obsidian } = this.deps;
    const daily = await obsidian.readDailyNote(date);
    if (!daily) return null;
    return obsidian.updateNote(daily.path, (note, write) => {
      const habit = this.habitAt(note, index, digest);
      if (habit)
        write(
          note.replace(habit.line, () =>
            completeHabitLine(habit.line, date, value),
          ),
        );
      return habit;
    });
  }

  private habitAt(note: string, index: number, digest: string): Habit | null {
    return (
      parseHabits(note, this.deps.heading).find(
        (habit) => habit.index === index && fingerprint(habit.line) === digest,
      ) ?? null
    );
  }

  private async cleanup(date: string): Promise<void> {
    const msgId = this.activeMsg.get(date);
    if (!msgId) return;
    await this.deps.notifier.delete(msgId).catch(() => {});
    this.activeMsg.delete(date);
  }
}
