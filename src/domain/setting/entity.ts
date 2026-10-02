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
  const s = raw?.trim();
  const n = Number(s);
  return s && Number.isInteger(n) && n >= 0 ? n : 280;
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
