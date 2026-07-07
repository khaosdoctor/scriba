/**
 * Time helpers. Date-based; local getters honour process.env.TZ for wall-clock values.
 */

/** "HH:MM:SS" for the given instant (default now). */
export function plainTime(epochMs: number = Date.now()): string {
	const d = new Date(epochMs);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "YYYY-MM-DD" for the given instant (default now). */
export function plainDate(epochMs: number = Date.now()): string {
	const d = new Date(epochMs);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "YYYY-MM-DD" of the calendar day before the given instant (default now). Used by the
 *  midnight rating prompt: at 00:00 the day just ended, so we rate yesterday. */
export function previousDate(epochMs: number = Date.now()): string {
	const d = new Date(epochMs);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - 1);
	return plainDate(d.getTime());
}

/** Milliseconds from now until the next occurrence of HH:MM local time. */
export function msUntilNext(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	const now = new Date();
	const next = new Date(now);
	next.setHours(h ?? 0, m ?? 0, 0, 0);
	if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
	return next.getTime() - now.getTime();
}
