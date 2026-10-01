import { config } from "../config.ts";
import {
  parseClockTime,
  RATING_SWITCH_KEY,
  ratingDay,
  switchEnabled,
} from "../core.ts";
import type { Repository } from "../db.ts";
import type { JotProcessor } from "../runtime/processor.ts";
import { logger } from "./log.ts";
import { msUntilNext, plainDate, previousDate, startOfToday } from "./time.ts";

const log = logger("scheduler");

/** Owns the recurring jobs: the nightly summary, the rating and habit prompts, the morning
 *  task summary, and the forever-retry sweep. */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  // The rating time is the one that changes at runtime (from /menu), so it has its own timer.
  private ratingAt: string = config.ratingTime;
  private ratingTimer?: NodeJS.Timeout;
  private started = false;

  constructor(
    private repo: Repository,
    private processor: JotProcessor,
    private notify: (text: string) => Promise<void>,
    private askRating: (date: string) => Promise<void>,
    private askHabits: (date: string) => Promise<void>,
    private sendTaskSummary: () => Promise<void>,
    private retryMs = 5 * 60_000,
  ) {}

  start(): void {
    this.scheduleDaily(
      config.summaryTime,
      () => this.sendSummary(),
      "daily summary",
    );
    this.started = true;
    this.armRating();
    // Fires at 00:00 → review the day that just ended, i.e. yesterday.
    this.scheduleDaily(
      config.habitsTime,
      () => this.askHabits(previousDate()),
      "daily habit review",
    );
    // The one message of the day meant to interrupt: what's due today and what is still
    // hanging over from before, in the morning, whether or not you ask.
    this.scheduleDaily(
      config.tasksTime,
      () => this.sendTaskSummary(),
      "daily task summary",
    );
    log.info(
      {
        retryMs: this.retryMs,
        summaryTime: config.summaryTime,
        ratingTime: this.ratingAt,
        habitsTime: config.habitsTime,
        tasksTime: config.tasksTime,
      },
      "scheduler started",
    );
    let sweeping = false; // don't let a slow sweep overlap the next tick
    const retry = setInterval(async () => {
      if (sweeping) return;
      sweeping = true;
      try {
        await this.processor.retrySweep();
      } catch (e) {
        log.error({ err: e }, "retry sweep failed");
      } finally {
        sweeping = false;
      }
    }, this.retryMs);
    retry.unref();
    this.timers.push(retry);
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.ratingTimer);
    for (const t of this.timers) clearTimeout(t);
  }

  /** Move the nightly rating to `time` (HH:MM). Before `start` it only records the time;
   *  once running it re-arms, so the change applies to the very next occurrence. */
  setRatingTime(time: string): void {
    const at = parseClockTime(time);
    if (!at) {
      log.warn({ time }, "rating time rejected: not HH:MM");
      return;
    }
    this.ratingAt = at;
    log.info({ time: at }, "rating time set");
    if (this.started) this.armRating();
  }

  /** Arm the rating prompt for the next occurrence of `ratingAt`, replacing any timer
   *  already armed. The next night is armed before the prompt runs, so a prompt that hangs
   *  or fails can't stop the ones after it. */
  private armRating(): void {
    clearTimeout(this.ratingTimer);
    const wait = msUntilNext(this.ratingAt);
    log.debug(
      { inMs: wait, at: this.ratingAt },
      "next rating prompt scheduled",
    );
    this.ratingTimer = setTimeout(async () => {
      this.armRating();
      try {
        await this.fireRating();
      } catch (e) {
        log.error({ err: e }, "daily rating prompt failed");
      }
    }, wait);
    this.ratingTimer.unref();
  }

  private async fireRating(): Promise<void> {
    if (!switchEnabled(await this.repo.getSetting(RATING_SWITCH_KEY))) {
      log.info("nightly rating is off, skipping");
      return;
    }
    await this.askRating(ratingDay(this.ratingAt));
  }

  /** Arm a `time`-of-day job: wait until the next HH:MM occurrence, run `task`, then
   *  re-arm for tomorrow regardless of outcome. `label` names the job in its logs. */
  private scheduleDaily(
    time: string,
    task: () => Promise<void>,
    label: string,
  ): void {
    const wait = msUntilNext(time);
    log.debug({ inMs: wait, at: time }, `next ${label} scheduled`);
    const t = setTimeout(async () => {
      try {
        await task();
      } catch (e) {
        log.error({ err: e }, `${label} failed`);
      }
      this.scheduleDaily(time, task, label); // re-arm for tomorrow
    }, wait);
    t.unref();
    this.timers.push(t);
  }

  private async sendSummary(): Promise<void> {
    const s = await this.repo.windowStats(startOfToday(), Date.now());
    const failed = s.failed + s.abandoned;
    log.info({ jots: s.total, audio: s.audio, failed }, "daily summary");
    if (s.total === 0) return; // nothing today → say nothing

    const lines = [`📓 ${plainDate()}`, `Jots: ${s.total} (voice: ${s.audio})`];
    if (failed) lines.push(`⚠️ Failed/abandoned: ${failed}`);
    await this.notify(lines.join("\n"));
  }
}
