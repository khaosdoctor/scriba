import { parseClockTime } from "../../libs/time.ts";

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
  parse(raw: string | undefined): unknown;
  label?(on: boolean): string;
}

const text = (raw: string | undefined) => raw;
const onUnlessOff = (raw: string | undefined) => raw !== "off";
const onOff = (name: string) => (on: boolean) => `${name} ${on ? "on" : "off"}`;

function entryMaxChars(raw: string | undefined): number {
  const trimmed = raw?.trim();
  const count = Number(trimmed);
  return trimmed && Number.isInteger(count) && count >= 0 ? count : 280;
}

/** A typed entry-size reply: a whole number of characters, or "off" to stop splitting.
 *  Null when it isn't usable: under 40 characters no sentence would ever fit. */
export function parseEntrySize(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "off" || trimmed === "none" || trimmed === "0") return 0;
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return count >= 40 && count <= 4000 ? count : null;
}

export function ratingTimeOrFallback(
  stored: string | undefined,
  fallback: string,
): string {
  return stored ?? parseClockTime(fallback) ?? fallback;
}

export const SETTINGS = {
  entryMaxChars: { kind: "number", parse: entryMaxChars },
  fixVoiceTranscript: {
    kind: "switch",
    parse: (raw) => raw === "on",
    label: onOff("Voice fix"),
  },
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
