/**
 * Time helpers. Date-based; local getters honour process.env.TZ for wall-clock values.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Matches a bare "YYYY-MM-DD" date string. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `date` is DATE_RE-shaped *and* safe to pass to dayBounds/dateFromIso
 *  without throwing. DATE_RE alone accepts years 0000-0099, which collide with JS
 *  Date's 1900-1999 special case (see dayBounds) — callers that only checked DATE_RE
 *  before calling dayBounds would still hit its throw for one of those. */
export function isValidDate(date: string): boolean {
	return DATE_RE.test(date) && Number(date.slice(0, 4)) >= 100;
}

/** "HH:MM:SS" for the given instant (default now). */
export function plainTime(epochMs: number = Date.now()): string {
	const d = new Date(epochMs);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "YYYY-MM-DD" for the given instant (default now). */
export function plainDate(epochMs: number = Date.now()): string {
	const d = new Date(epochMs);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight Date for a "YYYY-MM-DD" string — the inverse of plainDate. Throws on
 *  anything not matching DATE_RE (Number() on a malformed segment yields NaN, not
 *  undefined, so a `??` fallback can't catch it — reject up front instead). */
export function dateFromIso(date: string): Date {
	if (!DATE_RE.test(date))
		throw new Error(`dateFromIso: not a YYYY-MM-DD date: ${date}`);
	const [y, m, d] = date.split("-").map(Number);
	return new Date(y!, m! - 1, d!);
}

/** Local midnight (00:00:00.000) of the day containing `epochMs` (default now), as an
 *  epoch — the start of a "today" window for day-scoped stats. */
export function startOfToday(epochMs: number = Date.now()): number {
	const d = new Date(epochMs);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** "YYYY-MM-DD" of the calendar day before the given instant (default now). Used by the
 *  midnight rating prompt: at 00:00 the day just ended, so we rate yesterday. */
export function previousDate(epochMs: number = Date.now()): string {
	const d = new Date(startOfToday(epochMs));
	d.setDate(d.getDate() - 1);
	return plainDate(d.getTime());
}

/** [start, end) epoch-ms bounds of the local calendar day for a "YYYY-MM-DD" string —
 *  the window a date-scoped reprocess query filters `received_at` against. The end is
 *  the next local midnight, not `start + 24h`: a fixed offset lands short/long on a DST
 *  transition day (23h/25h), which would miss or over-include jots near the boundary. */
export function dayBounds(date: string): [number, number] {
	// A year below 100 hits JS Date's 0-99-is-1900+ special case — check the raw string
	// before dateFromIso silently reinterprets it (after which start.getFullYear() no
	// longer reflects what was actually typed).
	if (!isValidDate(date))
		throw new Error(
			`dayBounds: not a valid YYYY-MM-DD date (year 0-99 collides with Date's 1900-1999 special case): ${date}`,
		);
	const start = dateFromIso(date);
	const end = new Date(
		start.getFullYear(),
		start.getMonth(),
		start.getDate() + 1,
	);
	return [start.getTime(), end.getTime()];
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
