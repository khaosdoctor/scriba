/**
 * Pure, dependency-free helpers. Deterministic, token-free — unit-tested in isolation.
 * Stopwords and rejections are injected (they live in the DB), not hardcoded here.
 */
import { donePreview } from "./lib/jot.ts";
import { sectionHasContent } from "./lib/note.ts";
import { escapeHtml, pluralize, TELEGRAM_LIMIT } from "./lib/text.ts";
import { plainDate } from "./lib/time.ts";
import type { Jot, JotKind, JotStatus } from "./models/domain.ts";

export {
  assetEmbed,
  combineEnrichSource,
  donePreview,
  editedJotText,
  embedOffer,
  enrichableSource,
  isEditableJot,
  isRecoverable,
  makeJotId,
  parseLiteralEdit,
  reprocessTargets,
  setEmbeds,
  withinSquashWindow,
} from "./lib/jot.ts";
export type { AliasEntry, Candidate } from "./lib/links.ts";
export {
  candidates,
  cleanNoteTitle,
  distinctSurfaces,
  forcedCandidates,
  isDateLike,
  isEmbeddableUrl,
  linkDateWords,
  matchAlias,
  noteSuggestions,
  parseRuleWords,
  tokenize,
} from "./lib/links.ts";
export type { ModelPayload } from "./lib/model.ts";
export {
  CircuitBreaker,
  parseModelJson,
  unwrapModelPayload,
} from "./lib/model.ts";
export type { MoveResult } from "./lib/note.ts";
export {
  anchorLine,
  deleteAnchorLine,
  findSection,
  insertJournalLine,
  journalLine,
  moveAnchorLine,
  placeholderLine,
  replaceAnchorLine,
  sectionHasContent,
  setFrontmatterValue,
  stampCompletion,
  stripJournalLine,
  stripTilPrefix,
} from "./lib/note.ts";
export {
  escapeHtml,
  escapeRe,
  fitTelegram,
  formatDuration,
  htmlToText,
  pluralize,
  splitEntry,
  TELEGRAM_LIMIT,
} from "./lib/text.ts";
export { parseClockTime, ratingDay } from "./lib/time.ts";
export { OPENCODE_BASE_URL } from "./services/enrich.ts";
export { modelsUrlFor } from "./services/health.ts";
export { isInsideRoot } from "./services/vault.ts";
export { entitiesToMarkdown } from "./views/input.ts";

/** `total` is the number of jots folded into one line (leader + followers); 0 means no
 *  squash. The single confirmation notes it so the merge is explained. */
export function squashLine(total: number): string {
  return total > 1 ? `\n🧵 ${total} jots squashed into one entry` : "";
}

/** Final in-chat confirmation once a jot lands: the saved line blockquoted with its
 *  time so it stands out. HTML parse mode — content is escaped. */
export function doneMessage(
  time: string,
  kind: JotKind,
  textPart: string,
  id: string,
  squashedTotal = 0,
  part?: { i: number; of: number },
): string {
  // `part` is set when the text was too long and got split: each piece is its own jot with
  // its own message, so say which one this is.
  const split = part ? `\n✂️ part ${part.i} of ${part.of}` : "";
  return `✅ Saved to your journal\n<blockquote>🕒 ${time} · ${escapeHtml(donePreview(kind, textPart))}</blockquote>\n🔖 <code>${id}</code>${squashLine(squashedTotal)}${split}`;
}

// A failure message is only as useful as what you can do about it, and both messages below
// are posted with 🔄 Retry / 🗑 Delete under them. An error string can be a whole stack
// trace, which would push the message past Telegram's limit, so it's cut here.
const ERROR_PREVIEW_CHARS = 400;

const errorBlock = (error: string) => {
  const text = error.trim() || "(no error message)";
  const cut = text.length > ERROR_PREVIEW_CHARS;
  return `<code>${escapeHtml(cut ? `${text.slice(0, ERROR_PREVIEW_CHARS)}…` : text)}</code>`;
};

/** Status line for a jot that failed on a transient error and is still in the retry cycle.
 *  Without this the message sits on "Weaving it into your journal…" until the sweep comes
 *  round, which reads as a jot that's stuck rather than one that's waiting. */
export function retryNotice(
  kind: JotKind,
  attempts: number,
  max: number,
  error: string,
): string {
  const left = Math.max(0, max - attempts);
  const more = left === 1 ? "one more try" : `${left} more tries`;
  return `⚠️ That ${kind} jot didn't go through (attempt ${attempts} of ${max}). I'll try again on my own — ${more} left, or decide it now.\n${errorBlock(error)}`;
}

/** Status line for a jot held back because every enrichment model is down. It keeps its
 *  place in the note and isn't charged a retry; the sweep picks it up once one is back. */
export function heldNotice(kind: JotKind): string {
  return `⏸ Every enrichment model is down right now, so this ${kind} jot is waiting. It goes into your journal on its own once one is back.`;
}

/** Status line once a jot is given up on. The text is in the note un-enriched, so what's
 *  left to decide is whether to run it again or take it out. */
export function gaveUpMessage(
  kind: JotKind,
  reason: string,
  error: string,
  squashedTotal = 0,
): string {
  return `⚠️ Gave up on a ${kind} jot (${reason}). Posted it un-enriched.\n${errorBlock(error)}${squashLine(squashedTotal)}`;
}

/** In-chat confirmation after an edit is applied: the corrected line blockquoted so the
 *  new text is visible immediately, not just a bare "updated". HTML parse mode — content
 *  is escaped. */
export function editConfirmation(time: string, text: string): string {
  return `✏️ Updated\n<blockquote>🕒 ${time} · ${escapeHtml(text.trim() || "…")}</blockquote>`;
}

// --- entry splitting ---
// A long jot reads as a wall of text on one journal line, so an entry over `maxChars` is
// broken up — and each piece becomes a jot in its own right (own id, own line, own status
// message), so it can be edited or deleted on its own. Token-free: paragraph breaks are
// topic boundaries (the enricher is asked to place them when it knows the text is over the
// limit — see services/enrich.ts) and sentences are packed greedily inside each topic. A
// sentence is never cut in half; one longer than the limit goes out whole, because a
// mid-sentence break is the worse outcome.

/** A typed entry-size reply: a whole number of characters, or "off" to stop splitting.
 *  Null when it isn't usable — under 40 characters no sentence would ever fit. */
export function parseEntrySize(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (s === "off" || s === "none" || s === "0") return 0;
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 40 && n <= 4000 ? n : null;
}

/** The follow-up questions after the nightly rating, in the order they are asked. */
export const FOLLOWUP_QUESTIONS = ["journal", "til"] as const;
export type FollowupQuestion = (typeof FOLLOWUP_QUESTIONS)[number];

/** Which follow-up questions a day's note still needs: the journal line when "Journal" has
 *  no jots, the TIL when "TIL" is empty. `note` is null for a day that has no note yet.
 *  `after` leaves out that question and the ones before it. */
export function followupQuestions(
  note: string | null,
  headings: { journal: string; til: string },
  after?: FollowupQuestion,
): FollowupQuestion[] {
  const empty: Record<FollowupQuestion, boolean> = {
    journal: !note || !sectionHasContent(note, headings.journal),
    til: !note || !sectionHasContent(note, headings.til),
  };
  const from = after ? FOLLOWUP_QUESTIONS.indexOf(after) + 1 : 0;
  return FOLLOWUP_QUESTIONS.slice(from).filter((q) => empty[q]);
}

/** Marker in a follow-up prompt's text, so a reply can be routed back to it (the same trick
 *  the habits flow uses): `(fu:j:2026-07-05)` for the journal line, `(fu:t:…)` for the TIL. */
export const FOLLOWUP_CODES: Record<FollowupQuestion, string> = {
  journal: "j",
  til: "t",
};

export function followupRef(question: FollowupQuestion, date: string): string {
  return `(fu:${FOLLOWUP_CODES[question]}:${date})`;
}

/** The question a `j`/`t` code stands for, from a prompt marker or a Skip button. */
export function followupFromCode(
  code: string | undefined,
): FollowupQuestion | null {
  return FOLLOWUP_QUESTIONS.find((q) => FOLLOWUP_CODES[q] === code) ?? null;
}

export function parseFollowupRef(
  text: string,
): { question: FollowupQuestion; date: string } | null {
  const m = text.match(/\(fu:([a-z]):(\d{4}-\d{2}-\d{2})\)/);
  const question = followupFromCode(m?.[1]);
  return m && question ? { question, date: m[2]! } : null;
}

// --- /command live updates -------------------------------------------------------------
// While the vault assistant works, its reasoning, tool calls and intermediate prose are
// relayed to the chat as they happen. Those are chatter around the answer, not the answer:
// each one is flattened to a single line and hard-capped, so a long thought or a note-sized
// tool argument can't bury the conversation. They all live inside the turn's one status
// message, which is rewritten as they arrive — a message per thought floods the chat.

/** Hard cap on one live agent update. */
export const AGENT_UPDATE_CHARS = 330;

/** The live status message: a header, then the tail of what the agent has been up to. */
export function feedMessage(header: string, lines: string[]): string {
  return lines.length ? `${header}\n\n${lines.join("\n")}` : header;
}

/** Drop lines off the front until the rendered message fits. The message is a live view of
 *  what the agent is doing now, not a transcript, so the oldest line is the one to lose —
 *  and what's left is what the next render starts from, so the tail can't grow unbounded.
 *  The newest line is always kept, even alone: something has to be on screen. */
export function fitFeed(
  header: string,
  lines: string[],
  limit = TELEGRAM_LIMIT,
): string[] {
  const kept = [...lines];
  while (kept.length > 1 && feedMessage(header, kept).length > limit)
    kept.shift();
  return kept;
}

// A uniform 💭 on every line makes the feed one grey wall. Each line gets an emoji for what
// it actually is instead, so a glance says which part of the job the agent is on. The
// choice is a lookup, never a model call — this is display, and display must not cost a
// token or a round trip.

/** One per tool, keyed by the bare name `formatToolCall` produces. */
const TOOL_ICONS: Record<string, string> = {
  vault_read: "📖",
  vault_list: "📂",
  vault_search: "🔍",
  vault_write: "✍️",
  vault_delete: "🗑",
  web_fetch: "🌐",
  WebSearch: "🔎",
};

/** What a line of the agent's own words is about. First match wins, so the specific
 *  patterns come before the general ones. */
const THOUGHT_ICONS: [RegExp, string][] = [
  [/\b(delet|remov|drop)/i, "🗑"],
  [/\b(writ|creat|draft|updat|add)/i, "✍️"],
  [/\b(search|find|look(ing)? for|grep)/i, "🔍"],
  [/\b(read|open|check(ing)? the|inspect)/i, "📖"],
  [/\b(list|folder|director)/i, "📂"],
  [/\b(fetch|web|http|url|site|page|research)/i, "🌐"],
  [/\b(style|voice|tone|match|convention|shape)/i, "🎨"],
  [/\b(date|day|yesterday|today|journal)/i, "📅"],
  [/\b(link|wikilink|backlink)/i, "🔗"],
  [/\b(fail|error|wrong|can'?t|couldn'?t|problem)/i, "⚠️"],
  [/\b(done|finish|complete|ready|saved)/i, "✅"],
  [/\b(ask|question|clarif|unsure|not sure)/i, "❓"],
  [/\b(plan|first|then|next|need to|should)/i, "🧭"],
];

/** Emoji for a tool call. Unknown tools keep the generic wrench. */
export function toolIcon(name: string): string {
  return TOOL_ICONS[name.replace(/^mcp__.*?__/, "")] ?? "🔧";
}

/** Emoji for a line the agent wrote — its reasoning, or prose along the way. */
export function thoughtIcon(text: string): string {
  for (const [pattern, icon] of THOUGHT_ICONS)
    if (pattern.test(text)) return icon;
  return "💭";
}

/** Flatten to one line and cut to `max` characters, on a word boundary where there is one
 *  near the end. The returned string is never longer than `max`. */
export function clipUpdate(text: string, max = AGENT_UPDATE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const body = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${body.trimEnd()}…`;
}

/** Arguments worth showing on a live tool line, most identifying first. */
const TOOL_ARGS = ["path", "url", "query", "dir", "pattern", "prompt"];

/** One-line rendering of a tool call: the bare tool name (the `mcp__<server>__` prefix is
 *  noise here) plus the argument that says what it is acting on. */
export function formatToolCall(
  name: string,
  input: Record<string, unknown> = {},
): string {
  const label = name.replace(/^mcp__.*?__/, "");
  const key = TOOL_ARGS.find(
    (k) => typeof input[k] === "string" && (input[k] as string).trim(),
  );
  const detail = key ? ` · ${String(input[key]).trim()}` : "";
  // A write carries the whole note; its size is the useful part, never the body.
  const size =
    typeof input.content === "string" ? ` (${input.content.length} chars)` : "";
  return `${label}${detail}${size}`;
}

/** What a turn that stopped producing anything is answered with. The conversation itself
 *  survives (the next prompt resumes the session id), so the way out is to ask again. */
export function silentNotice(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `⚠️ The assistant went quiet — nothing at all for ${pluralize(mins, "minute")}, so I stopped waiting on it. Send that again and it picks the conversation up where it left off.`;
}

/** Status line for a prompt that arrived while the assistant was still on an earlier one.
 *  It says the message was seen — the whole point of accepting it right away. */
export function queuedNotice(ahead: number): string {
  return `🕐 Queued — ${pluralize(ahead, "message")} ahead of this one. It goes to the assistant as soon as that's done, and the reply lands here.`;
}

/** Inline preview of a list: the first `max` entries, then a count of what's left out. */
export function previewList(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} … +${items.length - max} more`;
}

/** /jot body: full record for one jot. */
export function formatJotDetail(j: Jot): string {
  const text = j.transcript ?? j.raw_text ?? "(none)";
  const lines = [
    `🧾 ${j.id} [${j.kind}] — ${j.status}`,
    `Received: ${plainDate(j.received_at)} ${j.time}`,
    `Attempts: ${j.attempts}`,
    `Note: ${j.note_path} ^${j.anchor}`,
  ];
  if (j.asset_path) lines.push(`Asset: ${j.asset_path}`);
  if (j.error) lines.push(`Error: ${j.error}`);
  lines.push(`Text: ${text}`);
  return lines.join("\n");
}

// --- link-rules wizard: force-reply prompt parsing ---
// A Telegram reply carries no state of its own, so each prompt hides a marker in its own
// text and the reply is routed by that marker (the same trick the habits flow uses).

/** Marker in the wizard's "add never-link words" prompt. */
export const WIZARD_STOPWORD_REF = "(lw:sw)";
/** Marker in the wizard's "which word(s) should always link" prompt. */
export const WIZARD_REGISTER_REF = "(lw:rg)";
/** Marker in the wizard's "type the note title" prompt (the fallback when the vault
 *  index has no match to tap). */
export const WIZARD_NOTE_REF = "(lw:rgn)";
/** Marker in the wizard's "type a note title that doesn't exist yet" prompt — the vault
 *  index only knows notes that exist, and Obsidian creates a link's target on first click,
 *  so a pair can legitimately point at a note that hasn't been written. */
export const WIZARD_NEWNOTE_REF = "(lw:rgm)";
/** Marker in the wizard's "rename the word of pair N" prompt, written `(lw:rgw:N)`. */
export const WIZARD_RENAME_REF = "lw:rgw";
/** Marker in the "type an entry size" prompt — the same force-reply trick, for the one
 *  setting whose value is a free number rather than one of a handful of presets. */
export const WIZARD_ENTRYSIZE_REF = "(es:n)";
export const WIZARD_ENRICH_MODEL_REF = "(md:em)";
export const WIZARD_VOICEFIX_MODEL_REF = "(md:vfm)";
export const WIZARD_RATING_TIME_REF = "(rt:time)";

/** Which wizard prompt a reply is answering, if any. */
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
  // `rgn`/`rgw`/`rgm` before `rg` — alternation is first-match, and `rg` prefixes them all.
  const m = text.match(/\(lw:(sw|rgn|rgw|rgm|rg)(?::(\d+))?\)/);
  if (!m) return null;
  if (m[1] === "sw") return { kind: "sw" };
  if (m[1] === "rg") return { kind: "rg" };
  if (m[1] === "rgn") return { kind: "rgn" };
  if (m[1] === "rgm") return { kind: "rgm" };
  const index = Number(m[2]);
  return Number.isInteger(index) ? { kind: "rgw", index } : null;
}

/** One glyph per jot status — the /menu jots browser and /reprocess pickers. */
export const STATUS_ICON: Record<JotStatus, string> = {
  pending: "⏳",
  processing: "⚙️",
  done: "✅",
  failed: "❌",
  abandoned: "🪦",
  deleted: "🗑",
};

/** One-line content preview for list pickers (the /menu jots browser, /reprocess) —
 *  falls back to "(kind)" for attach-only jots with no caption. */
export function jotPreview(j: Jot, maxLen = 40): string {
  return (j.transcript ?? j.raw_text ?? `(${j.kind})`)
    .replace(/\s+/g, " ")
    .slice(0, maxLen);
}

/** Calendar grid for a year/month (1-12): weeks (Sun-first) of day-of-month numbers,
 *  0 for padding cells outside the month. Pure date math for the /reprocess date picker. */
export function monthGrid(year: number, month: number): number[][] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDow = new Date(year, month - 1, 1).getDay();
  const cells = [
    ...Array(startDow).fill(0),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(0);
  const weeks: number[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
