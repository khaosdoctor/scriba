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

/** A day rating: a whole number from 1 to 10, from a button's callback text. */
export const RatingSchema = z.coerce.number().int().min(1).max(10);

/** A typed 24-hour clock time, or null when it isn't one. */
export function parseClockTime(text: string): string | null {
  return ClockTimeSchema.safeParse(text).data ?? null;
}

/** The stored `settings` keys, spelled as they are in the table. */
export type SettingKey =
  | "entryMaxChars"
  | "fixVoiceTranscript"
  | "enrichModel"
  | "voiceFixModel"
  | "nightlyRating"
  | "nightlyFollowup"
  | "taskDetection"
  | "tilDetection"
  | "ratingTime"
  | "deployId";

interface Setting {
  kind: "switch" | "number" | "time" | "text";
  /** The typed value from the stored string; `undefined` is a key that was never written. */
  parse(raw: string | undefined): unknown;
  /** Switches only: the toast for a switch that was just set to `on`. */
  label?(on: boolean): string;
}

const text = (raw: string | undefined) => raw;
const onUnlessOff = (raw: string | undefined) => raw !== "off";
const onOff = (name: string) => (on: boolean) => `${name} ${on ? "on" : "off"}`;

/** Cap on one journal entry, in characters: 0 disables splitting, anything unusable
 *  (unset, blank, not a whole number) falls back to a tweet. */
function entryMaxChars(raw: string | undefined): number {
  const s = raw?.trim();
  const n = Number(s);
  return s && Number.isInteger(n) && n >= 0 ? n : 280;
}

export const SETTINGS = {
  entryMaxChars: { kind: "number", parse: entryMaxChars },
  // Opt-in: unset or anything other than "on" means off.
  fixVoiceTranscript: {
    kind: "switch",
    parse: (raw) => raw === "on",
    label: onOff("Voice fix"),
  },
  // The two models are seeded from config on first boot.
  enrichModel: { kind: "text", parse: text },
  voiceFixModel: { kind: "text", parse: text },
  nightlyRating: {
    kind: "switch",
    parse: onUnlessOff,
    label: onOff("Nightly rating"),
  },
  nightlyFollowup: {
    kind: "switch",
    parse: onUnlessOff,
    label: onOff("Follow-up"),
  },
  taskDetection: {
    kind: "switch",
    parse: onUnlessOff,
    label: (on) =>
      on ? "I'll suggest tasks again" : "I'll stop suggesting tasks",
  },
  tilDetection: {
    kind: "switch",
    parse: onUnlessOff,
    label: (on) =>
      on ? "I'll suggest TILs again" : "I'll stop suggesting TILs",
  },
  // A valid stored time, normalised; the caller supplies the configured fallback.
  ratingTime: {
    kind: "time",
    parse: (raw) => parseClockTime(raw ?? "") ?? undefined,
  },
  deployId: { kind: "text", parse: text },
} as const satisfies Record<SettingKey, Setting>;

export type SettingValue<K extends SettingKey> = ReturnType<
  (typeof SETTINGS)[K]["parse"]
>;

export type SwitchKey = {
  [K in SettingKey]: (typeof SETTINGS)[K]["kind"] extends "switch" ? K : never;
}[SettingKey];
