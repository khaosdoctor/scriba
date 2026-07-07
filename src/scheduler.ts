import type { Repository } from "./db.ts";
import type { JotProcessor } from "./processor.ts";
import { config } from "./config.ts";
import { plainDate, previousDate, msUntilNext } from "./time.ts";
import { logger } from "./log.ts";

const log = logger("scheduler");

/** Owns the two recurring jobs: the nightly summary and the forever-retry sweep. */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private repo: Repository,
    private processor: JotProcessor,
    private notify: (text: string) => Promise<void>,
    private askRating: (date: string) => Promise<void>,
    private askHabits: (date: string) => Promise<void>,
    private retryMs = 5 * 60_000,
  ) {}

  start(): void {
    this.scheduleSummary();
    this.scheduleRating();
    this.scheduleHabits();
    log.info(
      { retryMs: this.retryMs, summaryTime: config.summaryTime, ratingTime: config.ratingTime, habitsTime: config.habitsTime },
      "scheduler started",
    );
    let sweeping = false; // don't let a slow sweep overlap the next tick
    const retry = setInterval(async () => {
      if (sweeping) return;
      sweeping = true;
      try { await this.processor.retrySweep(); }
      catch (e) { log.error({ err: e }, "retry sweep failed"); }
      finally { sweeping = false; }
    }, this.retryMs);
    retry.unref();
    this.timers.push(retry);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  private scheduleSummary(): void {
    const wait = msUntilNext(config.summaryTime);
    log.debug({ inMs: wait, at: config.summaryTime }, "next daily summary scheduled");
    const t = setTimeout(async () => {
      try { await this.sendSummary(); } catch (e) { log.error({ err: e }, "summary failed"); }
      this.scheduleSummary(); // re-arm for tomorrow
    }, wait);
    t.unref();
    this.timers.push(t);
  }

  private scheduleRating(): void {
    const wait = msUntilNext(config.ratingTime);
    log.debug({ inMs: wait, at: config.ratingTime }, "next daily rating prompt scheduled");
    const t = setTimeout(async () => {
      // Fires at 00:00 → the day that just ended is yesterday.
      try { await this.askRating(previousDate()); } catch (e) { log.error({ err: e }, "rating prompt failed"); }
      this.scheduleRating(); // re-arm for tomorrow
    }, wait);
    t.unref();
    this.timers.push(t);
  }

  private scheduleHabits(): void {
    const wait = msUntilNext(config.habitsTime);
    log.debug({ inMs: wait, at: config.habitsTime }, "next daily habit review scheduled");
    const t = setTimeout(async () => {
      // Fires at 00:00 → review the day that just ended, i.e. yesterday.
      try { await this.askHabits(previousDate()); } catch (e) { log.error({ err: e }, "habit prompt failed"); }
      this.scheduleHabits(); // re-arm for tomorrow
    }, wait);
    t.unref();
    this.timers.push(t);
  }

  private async sendSummary(): Promise<void> {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const stats = await this.repo.dayStats(start.getTime(), Date.now());
    log.info(stats, "daily summary");
    if (stats.jots === 0) return; // nothing today → say nothing

    const lines = [`📓 ${plainDate()}`, `Jots: ${stats.jots} (voice: ${stats.audio})`];
    if (stats.failed) lines.push(`⚠️ Failed/abandoned: ${stats.failed}`);
    await this.notify(lines.join("\n"));
  }
}
