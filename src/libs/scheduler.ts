import { logger } from "./log.ts";
import { msUntilNext } from "./time.ts";

const log = logger("scheduler");

type Job = () => Promise<void>;

interface Daily {
  name: string;
  time: () => string | Promise<string>;
  run: Job;
  armBeforeRun: boolean;
  at?: string;
  timer?: NodeJS.Timeout;
}

interface Interval {
  name: string;
  ms: number;
  run: Job;
  timer?: NodeJS.Timeout;
}

export class Scheduler {
  private dailies = new Map<string, Daily>();
  private intervals: Interval[] = [];
  private started = false;

  /** `time` is read at `start` and on every `rearm`. A job that arms before it runs keeps
   *  the next day's timer alive when the job hangs or fails; the default arms after. */
  daily(
    name: string,
    time: Daily["time"],
    run: Job,
    { armBeforeRun = false }: { armBeforeRun?: boolean } = {},
  ): void {
    this.dailies.set(name, { name, time, run, armBeforeRun });
  }

  every(name: string, ms: number, run: Job): void {
    this.intervals.push({ name, ms, run });
  }

  async start(): Promise<void> {
    this.started = true;
    const dailies = [...this.dailies.values()];
    for (const job of dailies) job.at = await job.time();
    if (!this.started) return;
    for (const job of dailies) this.arm(job);
    for (const job of this.intervals) this.tick(job);
    log.info(
      {
        daily: Object.fromEntries(dailies.map((job) => [job.name, job.at])),
        every: Object.fromEntries(
          this.intervals.map((job) => [job.name, job.ms]),
        ),
      },
      "scheduler started",
    );
  }

  stop(): void {
    this.started = false;
    for (const job of this.dailies.values()) clearTimeout(job.timer);
    for (const job of this.intervals) clearInterval(job.timer);
  }

  async rearm(name: string): Promise<void> {
    const job = this.dailies.get(name);
    if (!job) throw new Error(`no daily job named ${name}`);
    job.at = await job.time();
    log.info({ name, at: job.at }, "daily job time set");
    this.arm(job);
  }

  private arm(job: Daily): void {
    clearTimeout(job.timer);
    if (!this.started || job.at === undefined) return;
    const wait = msUntilNext(job.at);
    log.debug({ inMs: wait, at: job.at }, `next ${job.name} scheduled`);
    job.timer = setTimeout(async () => {
      if (job.armBeforeRun) this.arm(job);
      await this.guarded(job);
      if (!job.armBeforeRun) this.arm(job);
    }, wait);
    job.timer.unref();
  }

  private tick(job: Interval): void {
    let running = false;
    job.timer = setInterval(async () => {
      if (running) return;
      running = true;
      await this.guarded(job);
      running = false;
    }, job.ms);
    job.timer.unref();
  }

  private async guarded(job: Daily | Interval): Promise<void> {
    try {
      await job.run();
    } catch (error) {
      log.error({ err: error, job: job.name }, "scheduled job failed");
    }
  }
}
