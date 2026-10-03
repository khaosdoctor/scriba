import type { ModelKey } from "../../../services/settings.ts";

export const MENU_NS = "menu";

export const menu = (...parts: (string | number)[]) =>
  [MENU_NS, ...parts].join(":");

export const MENU_CLOSE = menu("close");

export const FLOW_EXPIRED = "That link flow expired — reopen /menu.";
export const NOTHING_TO_ADD = "Nothing to add — send a word.";

type ModelSpec = {
  key: ModelKey;
  title: string;
  label: string;
  logName: "enrich" | "voiceFix";
  pick: string;
  custom: string;
  button: [label: string, data: string];
};

export const MODELS: Record<"em" | "vfm", ModelSpec> = {
  em: {
    key: "enrichModel",
    title: "🧠 Enrichment model",
    label: "enrichment",
    logName: "enrich",
    pick: "ems",
    custom: "emc",
    button: ["🧠 Enrich model", menu("em")],
  },
  vfm: {
    key: "voiceFixModel",
    title: "🎤 Voice fix model",
    label: "voice fix",
    logName: "voiceFix",
    pick: "vfs",
    custom: "vfc",
    button: ["🎤 VF model", menu("vfm")],
  },
};
