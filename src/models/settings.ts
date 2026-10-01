import { z } from "zod";

/** A calendar day as "YYYY-MM-DD". Years 0000-0099 are refused because `new Date(y, m, d)`
 *  maps them to 1900-1999 and would reprocess the wrong day. */
export const IsoDateSchema = z.iso
  .date()
  .refine((d) => Number(d.slice(0, 4)) >= 100);

/** A 24-hour clock time, normalised to `HH:MM` ("9:30" becomes "09:30"). */
const ClockTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
  .transform((t) => t.padStart(5, "0"));

/** A typed 24-hour clock time, or null when it isn't one. */
export function parseClockTime(text: string): string | null {
  return ClockTimeSchema.safeParse(text).data ?? null;
}

/** Default cap on one journal entry, in characters: a tweet. */
export const DEFAULT_ENTRY_MAX_CHARS = 280;

/** Voice-fix is opt-in: unset or anything other than "on" means off. */
export function voiceFixEnabled(raw: string | undefined): boolean {
  return raw === "on";
}

/** The `entryMaxChars` setting as a number: 0 disables splitting, anything unusable (unset,
 *  blank, not a whole number) falls back to the default. */
export function entryMaxChars(raw: string | undefined): number {
  const s = raw?.trim();
  const n = Number(s);
  return s && Number.isInteger(n) && n >= 0 ? n : DEFAULT_ENTRY_MAX_CHARS;
}

/** Whether an on/off setting is on, from its raw value: only an explicit "off" turns it off. */
export function switchEnabled(raw: string | undefined): boolean {
  return raw !== "off";
}

/** The nightly rating time in force: the stored setting when it is a valid time, else the
 *  configured default. */
export function ratingTime(raw: string | undefined, fallback: string): string {
  return parseClockTime(raw ?? "") ?? parseClockTime(fallback) ?? fallback;
}
