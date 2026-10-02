import { z } from "zod";

/** A calendar day as "YYYY-MM-DD". Years 0000-0099 are refused because `new Date(y, m, d)`
 *  maps them to 1900-1999 and would reprocess the wrong day. */
export const IsoDateSchema = z.iso
  .date()
  .refine((d) => Number(d.slice(0, 4)) >= 100);

const ClockTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
  .transform((t) => t.padStart(5, "0"));

export function parseClockTime(text: string): string | null {
  return ClockTimeSchema.safeParse(text).data ?? null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function plainTime(epochMs: number = Date.now()): string {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function plainDate(epochMs: number = Date.now()): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight Date for a "YYYY-MM-DD" string, the inverse of plainDate. Throws on
 *  anything not matching DATE_RE (Number() on a malformed segment yields NaN, not
 *  undefined, so a `??` fallback can't catch it: reject up front instead). */
export function dateFromIso(date: string): Date {
  if (!DATE_RE.test(date))
    throw new Error(`dateFromIso: not a YYYY-MM-DD date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function startOfToday(epochMs: number = Date.now()): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function previousDate(epochMs: number = Date.now()): string {
  const d = new Date(startOfToday(epochMs));
  d.setDate(d.getDate() - 1);
  return plainDate(d.getTime());
}

/** [start, end) epoch-ms bounds of the local calendar day for a "YYYY-MM-DD" string:
 *  the window a date-scoped reprocess query filters `received_at` against. The end is
 *  the next local midnight, not `start + 24h`: a fixed offset comes out short/long on a DST
 *  transition day (23h/25h), which would miss or over-include jots near the boundary. */
export function dayBounds(date: string): [number, number] {
  if (!IsoDateSchema.safeParse(date).success)
    throw new Error(`dayBounds: not a valid YYYY-MM-DD calendar date: ${date}`);
  const start = dateFromIso(date);
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 1,
  );
  return [start.getTime(), end.getTime()];
}

export function msUntilNext(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h ?? 0, m ?? 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function ratingDay(time: string, now: number = Date.now()): string {
  const hour = Number((parseClockTime(time) ?? time).slice(0, 2));
  return hour < 12 ? previousDate(now) : plainDate(now);
}
