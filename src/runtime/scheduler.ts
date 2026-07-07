import { config } from "../config.ts";
import type { Repository } from "../db.ts";
import { logger } from "../log.ts";
import { msUntilNext, plainDate, previousDate, startOfToday } from "../time.ts";
import type { JotProcessor } from "./processor.ts";

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
		this.scheduleDaily(
			config.summaryTime,
			() => this.sendSummary(),
			"daily summary",
		);
		// Fires at 00:00 → the day that just ended is yesterday.
		this.scheduleDaily(
			config.ratingTime,
			() => this.askRating(previousDate()),
			"daily rating prompt",
		);
		// Fires at 00:00 → review the day that just ended, i.e. yesterday.
		this.scheduleDaily(
			config.habitsTime,
			() => this.askHabits(previousDate()),
			"daily habit review",
		);
		log.info(
			{
				retryMs: this.retryMs,
				summaryTime: config.summaryTime,
				ratingTime: config.ratingTime,
				habitsTime: config.habitsTime,
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
		for (const t of this.timers) clearTimeout(t);
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
		const stats = await this.repo.dayStats(startOfToday(), Date.now());
		log.info(stats, "daily summary");
		if (stats.jots === 0) return; // nothing today → say nothing

		const lines = [
			`📓 ${plainDate()}`,
			`Jots: ${stats.jots} (voice: ${stats.audio})`,
		];
		if (stats.failed) lines.push(`⚠️ Failed/abandoned: ${stats.failed}`);
		await this.notify(lines.join("\n"));
	}
}
