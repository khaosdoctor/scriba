import type { Repository } from "./db.ts";
import type { JotProcessor } from "./processor.ts";
import { config } from "./config.ts";
import { plainDate, msUntilNext } from "./time.ts";

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
    let sweeping = false; // don't let a slow sweep overlap the next tick
    const retry = setInterval(async () => {
      if (sweeping) return;
      sweeping = true;
      try { await this.processor.retrySweep(); }
      catch (e) { console.error("retry sweep failed", e); }
      finally { sweeping = false; }
    }, this.retryMs);
    retry.unref();
    this.timers.push(retry);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  private scheduleSummary(): void {
    const t = setTimeout(async () => {
      try { await this.sendSummary(); } catch (e) { console.error("summary failed", e); }
      this.scheduleSummary(); // re-arm for tomorrow
    }, msUntilNext(config.summaryTime));
    t.unref();
    this.timers.push(t);
  }

  private async sendSummary(): Promise<void> {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const stats = await this.repo.dayStats(start.getTime(), Date.now());
    if (stats.jots === 0) return; // nothing today → say nothing

    const lines = [`📓 ${plainDate()}`, `Jots: ${stats.jots} (voice: ${stats.audio})`];
    if (stats.failed) lines.push(`⚠️ Failed/abandoned: ${stats.failed}`);
    await this.notify(lines.join("\n"));
  }
}
