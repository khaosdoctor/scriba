/**
 * Adaptive batch flush. Pure timers — no tokens, no model calls to decide timing.
 * Flushes when ANY fires: idle gap since the last message, batch size cap, or a hard
 * max-wait since the oldest queued item (so a slow trickle still lands).
 */
import { logger } from "../log.ts";

const log = logger("queue");

export interface FlushOpts {
	idleMs: number;
	maxBatch: number;
	maxWaitMs: number;
	onFlush: (ids: string[]) => Promise<void>;
}

export class FlushQueue {
	private ids: string[] = [];
	private idleTimer: NodeJS.Timeout | null = null;
	private maxTimer: NodeJS.Timeout | null = null;
	private draining = false;

	constructor(private opts: FlushOpts) {}

	/** How many jots are waiting to be flushed — for /status. */
	get depth(): number {
		return this.ids.length;
	}

	add(id: string): void {
		this.ids.push(id);
		// While a flush is running, just accumulate — arm() runs again when it finishes.
		if (!this.draining) this.arm();
	}

	/** Bulk-enqueue: push every id, then arm once — a loop of add() calls re-arms the
	 *  idle/max timers on every single push, which is needless churn for a large batch
	 *  (e.g. /reprocess over a wide date range). */
	addMany(ids: string[]): void {
		if (!ids.length) return;
		this.ids.push(...ids);
		if (!this.draining) this.arm();
	}

	private arm(): void {
		if (this.ids.length === 0) return;
		if (this.ids.length >= this.opts.maxBatch) {
			log.debug({ size: this.ids.length }, "flush: batch cap hit");
			void this.flush();
			return;
		}
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.flush(), this.opts.idleMs);
		if (!this.maxTimer)
			this.maxTimer = setTimeout(() => void this.flush(), this.opts.maxWaitMs);
	}

	private clearTimers(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (this.maxTimer) {
			clearTimeout(this.maxTimer);
			this.maxTimer = null;
		}
	}

	async flush(): Promise<void> {
		if (this.draining) return;
		if (this.ids.length === 0) {
			this.clearTimers();
			return;
		}
		// At most maxBatch per flush — addMany() can queue far more than that in one
		// call, and draining it all in a single onFlush would bypass the cap the rest of
		// this class exists to enforce. splice() mutates `ids` down to the remainder.
		const batch = this.ids.splice(0, this.opts.maxBatch);
		this.clearTimers();
		this.draining = true;
		log.debug({ size: batch.length }, "flushing batch");
		try {
			await this.opts.onFlush(batch);
		} finally {
			this.draining = false;
			this.arm(); // handle whatever's left (this batch's remainder, or anything that arrived mid-flush)
		}
	}
}
