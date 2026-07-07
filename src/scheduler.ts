import type { Repository } from "./db.ts";
import type { JotProcessor } from "./processor.ts";
import { config } from "./config.ts";
import { plainDate, msUntilNext } from "./time.ts";
import { logger } from "./log.ts";

const log = logger("scheduler");

/** Owns the two recurring jobs: the nightly summary and the forever-retry sweep. */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private repo: Repository,
    private processor: JotProcessor,
    private notify: (text: string) => Promise<void>,
    private retryMs = 5 * 60_000,
  ) {}

  start(): void {
    this.scheduleSummary();
    log.info({ retryMs: this.retryMs, summaryTime: config.summaryTime }, "scheduler started");
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
