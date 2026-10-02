// A Telegram reply carries no state of its own, so each prompt hides a marker in its own
// text and the reply is routed by that marker (the same trick the habits flow uses).

export const WIZARD_STOPWORD_REF = "(lw:sw)";
export const WIZARD_REGISTER_REF = "(lw:rg)";
export const WIZARD_NOTE_REF = "(lw:rgn)";
export const WIZARD_NEWNOTE_REF = "(lw:rgm)";
export const WIZARD_RENAME_REF = "lw:rgw";
export const WIZARD_ENTRYSIZE_REF = "(es:n)";
export const WIZARD_ENRICH_MODEL_REF = "(md:em)";
export const WIZARD_VOICEFIX_MODEL_REF = "(md:vfm)";
export const WIZARD_RATING_TIME_REF = "(rt:time)";

export type WizardPrompt =
  | { kind: "sw" }
  | { kind: "rg" }
  | { kind: "rgn" }
  | { kind: "rgm" }
  | { kind: "rgw"; index: number }
  | { kind: "es" }
  | { kind: "em" }
  | { kind: "vfm" }
  | { kind: "rt" };

export function parseWizardRef(text: string): WizardPrompt | null {
  if (text.includes(WIZARD_ENTRYSIZE_REF)) return { kind: "es" };
  if (text.includes(WIZARD_ENRICH_MODEL_REF)) return { kind: "em" };
  if (text.includes(WIZARD_VOICEFIX_MODEL_REF)) return { kind: "vfm" };
  if (text.includes(WIZARD_RATING_TIME_REF)) return { kind: "rt" };
  // `rgn`/`rgw`/`rgm` before `rg`: alternation is first-match, and `rg` prefixes them all.
  const m = text.match(/\(lw:(sw|rgn|rgw|rgm|rg)(?::(\d+))?\)/);
  if (!m) return null;
  if (m[1] === "sw") return { kind: "sw" };
  if (m[1] === "rg") return { kind: "rg" };
  if (m[1] === "rgn") return { kind: "rgn" };
  if (m[1] === "rgm") return { kind: "rgm" };
  const index = Number(m[2]);
  return Number.isInteger(index) ? { kind: "rgw", index } : null;
}
