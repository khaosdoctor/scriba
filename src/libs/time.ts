import { z } from "zod";

/** A calendar day as "YYYY-MM-DD". Years 0000-0099 are refused because `new Date(y, m, d)`
 *  maps them to 1900-1999 and would reprocess the wrong day. */
export const IsoDateSchema = z.iso
  .date()
  .refine((date) => Number(date.slice(0, 4)) >= 100);

const ClockTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
  .transform((time) => time.padStart(5, "0"));

export function parseClockTime(text: string): string | null {
  return ClockTimeSchema.safeParse(text).data ?? null;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (date: string): boolean =>
  IsoDateSchema.safeParse(date).success;

export function plainTime(epochMs: number = Date.now()): string {
  const date = new Date(epochMs);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function plainDate(epochMs: number = Date.now()): string {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local midnight Date for a "YYYY-MM-DD" string, the inverse of plainDate. Throws on
 *  anything not matching DATE_RE (Number() on a malformed segment yields NaN, not
 *  undefined, so a `??` fallback can't catch it: reject up front instead). */
export function dateFromIso(date: string): Date {
  if (!DATE_RE.test(date))
    throw new Error(`dateFromIso: not a YYYY-MM-DD date: ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

export function startOfToday(epochMs: number = Date.now()): number {
  const date = new Date(epochMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function previousDate(epochMs: number = Date.now()): string {
  const date = new Date(startOfToday(epochMs));
  date.setDate(date.getDate() - 1);
  return plainDate(date.getTime());
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

export function weekBounds(date: string): [string, string] {
  const day = dateFromIso(date);
  const start = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() - day.getDay(),
  );
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 6,
  );
  return [plainDate(start.getTime()), plainDate(end.getTime())];
}

export function shiftDate(date: string, days: number): string {
  const day = dateFromIso(date);
  return plainDate(
    new Date(day.getFullYear(), day.getMonth(), day.getDate() + days).getTime(),
  );
}

export function msUntilNext(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour!, minute!, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function ratingDay(time: string, now: number = Date.now()): string {
  const hour = Number(parseClockTime(time)!.slice(0, 2));
  return hour < 12 ? previousDate(now) : plainDate(now);
}

export function monthGrid(year: number, month: number): number[][] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDow = new Date(year, month - 1, 1).getDay();
  const cells = [
    ...Array(startDow).fill(0),
    ...Array.from({ length: daysInMonth }, (_, day) => day + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(0);
  const weeks: number[][] = [];
  for (let start = 0; start < cells.length; start += 7)
    weeks.push(cells.slice(start, start + 7));
  return weeks;
}
