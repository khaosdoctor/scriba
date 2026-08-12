/**
 * Pure, dependency-free helpers. Deterministic, token-free — unit-tested in isolation.
 * Stopwords and rejections are injected (they live in the DB), not hardcoded here.
 */
import { randomBytes } from "node:crypto";
import { sep } from "node:path";
import * as chrono from "chrono-node";
import type { Jot, JotKind, JotStatus, StatsRow } from "./db.ts";
import type { ReleaseNote } from "./services/github.ts";
import { dateFromIso, plainDate } from "./time.ts";

// ponytail: swap for RegExp.escape once TypeScript ships its typedef (5.9 lacks it).
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- command mode sandbox ---
// `/command` runs an agent against the vault. Its limits are enforced in code, not asked
// for in the prompt: it gets no built-in tool at all (no Bash, no Read — those would reach
// the whole container: the sqlite db, the env, the tokens), only the handful of custom
// tools in services/vault.ts, and every path they take goes through the check below.

/** True when `target` is `root` itself or sits under it. Both must already be resolved to
 *  absolute paths; the caller still realpaths afterwards, since this is string-only and a
 *  symlink inside the vault can still point out of it. */
export function isInsideRoot(root: string, target: string): boolean {
	if (!root || !target) return false;
	const r = root.endsWith(sep) ? root.slice(0, -1) : root;
	return target === r || target.startsWith(r + sep);
}

/** Reduce a fetched page to readable text. A string transform, never a browser: script and
 *  style bodies are dropped rather than run, and nothing here can execute JS. */
export function htmlToText(html: string): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
		// Block-level ends become line breaks so the text keeps its shape.
		.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, "\n")
		.replace(/<(br|hr)\s*\/?>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
			String.fromCodePoint(Number.parseInt(h, 16)),
		);
	return text
		.split("\n")
		.map((l) => l.replace(/[ \t]+/g, " ").trim())
		.filter((l, i, all) => l !== "" || all[i - 1] !== "") // collapse blank runs
		.join("\n")
		.trim();
}

/** Fixed 8-char hex id, also used as the Obsidian block anchor. */
export function makeJotId(): string {
	return randomBytes(4).toString("hex");
}

/** Errors worth retrying (transient infra); anything else is treated as unrecoverable. */
export function isRecoverable(err: unknown): boolean {
	const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return /timeout|etimedout|econnrefused|econnreset|enotfound|eai_again|fetch failed|socket|network|429|overloaded|\b5\d\d\b/.test(
		m,
	);
}

/** A jot's line can be edited/deleted only once it exists in the note: done, or abandoned
 *  (posted un-enriched). Anything earlier still needs processing, so edits are queued. */
export function isEditableJot(status: JotStatus): boolean {
	return status === "done" || status === "abandoned";
}

/** Pick the enrichable source text for a jot's kind: the transcript for audio (falling back
 *  to `audioFallback` when there isn't one), the raw text for text, and an image's caption —
 *  what you typed alongside the photo is the entry, same as any other jot, so it gets
 *  enriched and wikilinked rather than being demoted to the embed's alt text. A captionless
 *  image uses its vision caption here. Video is still attach-only. */
export function enrichableSource(jot: Jot, audioFallback = ""): string {
	if (jot.kind === "audio") return jot.transcript ?? audioFallback;
	if (jot.kind === "text" || jot.kind === "image") return jot.raw_text ?? "";
	return "";
}

/** Obsidian embed for a jot's saved asset, or "" when it has none. An image's caption is
 *  the entry text (see enrichableSource), so its embed carries no alias — Telegram's Bot API
 *  exposes no alt-text field to copy one from, and repeating the entry text inside the embed
 *  would only duplicate the line. Video stays attach-only, so its caption is the display. */
export function assetEmbed(jot: Jot): string {
	if (!jot.asset_path) return "";
	const alias = jot.kind === "video" && jot.raw_text;
	return alias
		? `![[${jot.asset_path}|${jot.raw_text}]]`
		: `![[${jot.asset_path}]]`;
}

/** Rolling-gap test for squashing: a new jot folds into the previous still-open one
 *  when it arrived within `windowMs` of it. A `windowMs` of 0 disables squashing. */
export function withinSquashWindow(
	prevReceivedAt: number,
	nowReceivedAt: number,
	windowMs: number,
): boolean {
	return windowMs > 0 && nowReceivedAt - prevReceivedAt <= windowMs;
}

/** Join a squash group's source texts into one blob for a single enrichment pass.
 *  Blank parts are dropped so an empty caption or failed transcript adds no noise. */
export function combineEnrichSource(parts: string[]): string {
	return parts
		.map((p) => p.trim())
		.filter(Boolean)
		.join("\n");
}

/** Confirmation of what landed in the note, shown in full. Attach-only jots carry no text. */
export function donePreview(kind: JotKind, textPart: string): string {
	const text = textPart.trim();
	if (text) return text;
	if (kind === "image" || kind === "video") return `${kind} saved to the note`;
	return "saved";
}

/** Escape the five characters that matter for Telegram's HTML parse mode.*/
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export interface TelegramMessageEntity {
	type: string;
	offset: number;
	length: number;
	url?: string;
	language?: string;
	user?: { id: number; first_name: string; is_bot: boolean; username?: string };
	custom_emoji_id?: string;
}

/** Convert Telegram message entities to Markdown. Entities are in UTF-16 code units. */
export function entitiesToMarkdown(
	text: string,
	entities: TelegramMessageEntity[] | undefined,
): string {
	if (!entities?.length) return text;
	const sorted = [...entities].sort((a, b) => a.offset - b.offset);
	let out = "";
	let last = 0;
	for (const e of sorted) {
		const start = e.offset;
		const end = e.offset + e.length;
		// Flat serializer: skip entities nested in an already-emitted one
		// (bold-link, bold+italic same span). Drops inner formatting but never
		// duplicates text. Full nesting would need a boundary-marker tree.
		if (start < last) continue;
		out += text.slice(last, start);
		const content = text.slice(start, end);
		switch (e.type) {
			case "bold":
				out += `**${content}**`;
				break;
			case "italic":
				out += `_${content}_`;
				break;
			case "underline":
				out += `__${content}__`;
				break;
			case "strikethrough":
				out += `~~${content}~~`;
				break;
			case "spoiler":
				out += `||${content}||`;
				break;
			case "code":
				out += `\`${content}\``;
				break;
			case "pre":
				out += `\`\`\`${e.language ?? ""}\n${content}\n\`\`\``;
				break;
			case "text_link":
				out += `[${content}](${e.url})`;
				break;
			case "text_mention":
				out += `[@${content}](tg://user?id=${e.user?.id})`;
				break;
			case "custom_emoji":
				out += content;
				break;
			default:
				out += content;
		}
		last = end;
	}
	out += text.slice(last);
	return out;
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
	// squashedTotal is the number of jots folded into this one line (leader + followers);
	// 0 means no squash. When set, note it so the single confirmation explains the merge.
	const squash =
		squashedTotal > 1
			? `\n🧵 ${squashedTotal} jots squashed into one entry`
			: "";
	// `part` is set when the text was too long and got split: each piece is its own jot with
	// its own message, so say which one this is.
	const split = part ? `\n✂️ part ${part.i} of ${part.of}` : "";
	return `✅ Saved to your journal\n<blockquote>🕒 ${time} · ${escapeHtml(donePreview(kind, textPart))}</blockquote>\n🔖 <code>${id}</code>${squash}${split}`;
}

/** In-chat confirmation after an edit is applied: the corrected line blockquoted so the
 *  new text is visible immediately, not just a bare "updated". HTML parse mode — content
 *  is escaped. */
export function editConfirmation(time: string, text: string): string {
	return `✏️ Updated\n<blockquote>🕒 ${time} · ${escapeHtml(text.trim() || "…")}</blockquote>`;
}

/** Journal bullet in the vault's house style: `- _HH:MM:SS ::_ <text> ^anchor` */
export function journalLine(
	time: string,
	text: string,
	anchor: string,
): string {
	return `- _${time} ::_ ${text} ^${anchor}`;
}

// --- entry splitting ---
// A long jot reads as a wall of text on one journal line, so an entry over `maxChars` is
// broken up — and each piece becomes a jot in its own right (own id, own line, own status
// message), so it can be edited or deleted on its own. Token-free: paragraph breaks are
// topic boundaries (the enricher is asked to place them when it knows the text is over the
// limit — see services/enrich.ts) and sentences are packed greedily inside each topic. A
// sentence is never cut in half; one longer than the limit goes out whole, because a
// mid-sentence break is the worse outcome.

/** Default cap on one journal entry, in characters — a tweet. */
export const DEFAULT_ENTRY_MAX_CHARS = 280;

/** `settings` key holding the entry-size cap (set from /menu, survives a restart). */
export const ENTRY_MAX_CHARS_KEY = "entryMaxChars";

/** The `entryMaxChars` setting as a number: 0 disables splitting, anything unusable (unset,
 *  blank, not a whole number) falls back to the default. */
export function entryMaxChars(raw: string | undefined): number {
	const s = raw?.trim();
	const n = Number(s);
	return s && Number.isInteger(n) && n >= 0 ? n : DEFAULT_ENTRY_MAX_CHARS;
}

/** A typed entry-size reply: a whole number of characters, or "off" to stop splitting.
 *  Null when it isn't usable — under 40 characters no sentence would ever fit. */
export function parseEntrySize(text: string): number | null {
	const s = text.trim().toLowerCase();
	if (s === "off" || s === "none" || s === "0") return 0;
	if (!/^\d{1,4}$/.test(s)) return null;
	const n = Number(s);
	return n >= 40 && n <= 4000 ? n : null;
}

// A sentence ends at a terminator (plus any closing quote/bracket) followed by whitespace
// and something that isn't a lowercase letter — so "e.g. this" and "v1. 2" stay whole while
// real sentence ends split. Zero-width, so `split` keeps every character.
const SENTENCE_BOUNDARY = /(?<=[.!?…]["')\]]*)\s+(?=[^\p{Ll}\s])/u;

/** A bullet is one line: newlines and runs of whitespace collapse to single spaces. */
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Split an entry's text into bullet-sized chunks of at most `maxChars`, splitting on topic
 * (blank-line) boundaries first and sentence boundaries within a topic. `maxChars` of 0
 * disables splitting; text already under the limit comes back as one chunk.
 */
export function splitEntry(text: string, maxChars: number): string[] {
	const clean = collapse(text);
	if (!clean) return [];
	if (maxChars <= 0 || clean.length <= maxChars) return [clean];
	const out: string[] = [];
	for (const topic of text.split(/\n[ \t]*\n+/)) {
		let buf = "";
		for (const raw of topic.split(SENTENCE_BOUNDARY)) {
			const sentence = collapse(raw);
			if (!sentence) continue;
			const merged = buf ? `${buf} ${sentence}` : sentence;
			if (buf && merged.length > maxChars) {
				out.push(buf);
				buf = sentence;
			} else buf = merged;
		}
		if (buf) out.push(buf);
	}
	return out.length ? out : [clean];
}

/** Placeholder written the instant a jot arrives — fixes ordering, filled in later. */
export function placeholderLine(time: string, anchor: string): string {
	return journalLine(time, "⏳", anchor);
}

// An Obsidian block anchor is `^` plus letters/digits/dashes at the end of the line, and
// journalLine always writes it after a space — so requiring that space keeps a trailing
// "3^2" in the text itself from being read as one.
const ANCHOR_SUFFIX = /\s+\^[A-Za-z0-9-]+[ \t\r]*$/;

/** Strip the `- _time ::_ ` prefix and ` ^anchor` suffix off a journal line, leaving
 *  just its content (for literal edits). */
export function stripJournalLine(line: string, time: string): string {
	return line
		.replace(new RegExp(`^- _${escapeRe(time)} ::_ `), "")
		.replace(ANCHOR_SUFFIX, "");
}

/** Insert a journal bullet under `heading`, keeping the vault's indentation:
 *  immediately after the last bullet in that section, or replacing the list when
 *  it holds only the empty template bullet. Falls back to a heading-less append. */
export function insertJournalLine(
	note: string,
	heading: string,
	line: string,
): string {
	const lines = note.split("\n");
	const esc = escapeRe(heading);
	const headingRe = new RegExp(`^#{1,6}\\s+${esc}\\s*$`);
	const headingIdx = lines.findIndex((l) => headingRe.test(l));
	if (headingIdx === -1) return `${note.replace(/\n*$/, "")}\n${line}\n`;

	let end = lines.length;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i]!)) {
			end = i;
			break;
		}
	}

	let lastBullet = -1;
	const emptyBullets: number[] = [];
	for (let i = headingIdx + 1; i < end; i++) {
		if (/^\s*-\s*$/.test(lines[i]!)) emptyBullets.push(i);
		else if (/^\s*-\s/.test(lines[i]!)) lastBullet = i;
	}

	if (lastBullet !== -1) {
		lines.splice(lastBullet + 1, 0, line);
		return lines.join("\n");
	}
	if (emptyBullets.length === 0) {
		lines.splice(headingIdx + 1, 0, line);
		return lines.join("\n");
	}
	lines[emptyBullets[0]!] = line;
	for (const i of emptyBullets.slice(1).reverse()) lines.splice(i, 1);
	return lines.join("\n");
}

/** Set a numeric YAML frontmatter field, replacing it in place or inserting it into
 *  (or creating) the `---` block at the top of the note. Always returns a note that
 *  carries `key: value`. */
export function setFrontmatterNumber(
	note: string,
	key: string,
	value: number,
): string {
	const lines = note.split("\n");
	if (lines[0] !== "---") return `---\n${key}: ${value}\n---\n\n${note}`;
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) return `---\n${key}: ${value}\n---\n\n${note}`; // no closing fence: wrap
	const keyRe = new RegExp(`^${escapeRe(key)}\\s*:`);
	for (let i = 1; i < close; i++) {
		if (keyRe.test(lines[i]!)) {
			lines[i] = `${key}: ${value}`;
			return lines.join("\n");
		}
	}
	lines.splice(close, 0, `${key}: ${value}`); // key absent: add it before the closing fence
	return lines.join("\n");
}

const anchorRe = (anchor: string) =>
	new RegExp(`^.*\\^${escapeRe(anchor)}[ \\t\\r]*$`, "m");

/** Replace the whole line carrying `^anchor` with `newLine`. Returns null if not found.
 *  `newLine` may itself be several lines — a jot that split into parts writes its own line
 *  plus its parts' lines in one go, so they land together and in order. */
export function replaceAnchorLine(
	note: string,
	anchor: string,
	newLine: string,
): string | null {
	const re = anchorRe(anchor);
	if (!re.test(note)) return null;
	return note.replace(re, () => newLine); // function replacer: `$&` in the text is literal
}

/** Remove the line carrying `^anchor` entirely. Returns null if not found. */
export function deleteAnchorLine(note: string, anchor: string): string | null {
	const re = anchorRe(anchor);
	if (!re.test(note)) return null;
	return note.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

/** Extract the current text of the line carrying `^anchor` (for literal edits). */
export function anchorLine(note: string, anchor: string): string | null {
	return note.match(anchorRe(anchor))?.[0] ?? null;
}

export interface AliasEntry {
	note: string;
	alias: string;
}
export interface Candidate {
	surface: string;
	note: string;
	// Set for user-registered pairs (the opposite of a rejection): the enricher must
	// apply these unconditionally instead of judging them in context.
	forced?: boolean;
}

/** Split text into lowercased word tokens, unicode-aware (keeps accented letters). */
export function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Propose link candidates from an alias index — no model call. Drops junk (short or
 * stopword aliases) and anything the user rejected; survivors go to the agent.
 * `stopwords` are lowercased; `rejected` keys are `${lowercased-surface} ${note}`.
 */
export function candidates(
	text: string,
	index: AliasEntry[],
	stopwords: Set<string>,
	rejected: Set<string>,
): Candidate[] {
	const tokens = new Set(tokenize(text));
	const lower = text.toLowerCase();
	const out: Candidate[] = [];
	const seen = new Set<string>();
	for (const { note, alias } of index) {
		const a = alias.trim();
		const al = a.toLowerCase();
		if (a.length < 3 || stopwords.has(al)) continue; // 1-2 char aliases are junk; stopwords catch the rest
		const hit = al.includes(" ") ? lower.includes(al) : tokens.has(al);
		if (!hit) continue;
		const key = `${al} ${note}`;
		if (rejected.has(key) || seen.has(key)) continue;
		seen.add(key);
		out.push({ surface: a, note });
	}
	return out;
}

const wikilinkRe = /\[\[.*?\]\]/g;

/**
 * Spot relative-date phrases ("yesterday", "three weeks ago", "next Friday") and turn
 * each into a wikilink to that day's daily note, aliased to the original words — the
 * note doesn't need to exist yet, Obsidian creates it lazily on first click.
 * `referenceDate` is the jot's own day (not "now"), so a phrase in an old entry resolves
 * relative to that entry's day. Token-free (chrono-node is a deterministic parser, not
 * a model call) and never touches text already inside an existing `[[wikilink]]`.
 */
export function linkDateWords(text: string, referenceDate: string): string {
	if (!text.trim()) return text;
	const linkSpans = [...text.matchAll(wikilinkRe)].map(
		(m) => [m.index, m.index + m[0].length] as const,
	);
	const overlapsLink = (start: number, end: number) =>
		linkSpans.some(([s, e]) => start < e && end > s);

	const ref = dateFromIso(referenceDate);
	// chrono also matches bare times ("at 3pm", "meeting at 9") by defaulting the day to
	// the reference date — that's not a date word, it's a clock time, so require the
	// parse to have actually pinned down a day/weekday/month before linking it. "now" gets
	// the same certain-day treatment (it resolves to today) but reads as "this moment", not
	// a day reference, so it's excluded by its casual-reference tag rather than linked.
	const isDateLike = (r: chrono.ParsedResult) =>
		(r.start.isCertain("day") ||
			r.start.isCertain("weekday") ||
			r.start.isCertain("month")) &&
		!r.start.tags().has("casualReference/now");
	// chrono leans on `\b`, which is ASCII-only in JS: in "Pokémon" the accented é counts as
	// a non-word char, so "mon" looks like a standalone weekday and the word gets a Monday
	// link spliced into the middle of it. Re-check both edges against a Unicode letter/digit
	// class so a match only survives when it really is a whole word.
	const wordChar = /[\p{L}\p{N}]/u;
	const insideWord = (start: number, end: number) =>
		wordChar.test(text[start - 1] ?? "") || wordChar.test(text[end] ?? "");
	const matches = chrono.en.casual
		.parse(text, ref)
		.filter(
			(r) =>
				isDateLike(r) &&
				!overlapsLink(r.index, r.index + r.text.length) &&
				!insideWord(r.index, r.index + r.text.length),
		)
		.sort((a, b) => b.index - a.index); // right-to-left so earlier indices stay valid

	let out = text;
	for (const r of matches) {
		const date = plainDate(r.start.date().getTime());
		const start = r.index;
		const end = start + r.text.length;
		out = `${out.slice(0, start)}[[${date}|${r.text}]]${out.slice(end)}`;
	}
	return out;
}

/**
 * Force-link candidates from user-registered surface->note pairs (`/register`) — the
 * opposite of a rejection: hand-curated, so no length/stopword filtering applies. Marked
 * `forced` so the enricher links them unconditionally rather than judging context.
 */
export function forcedCandidates(
	text: string,
	registered: { surface: string; note: string }[],
): Candidate[] {
	const tokens = new Set(tokenize(text));
	const lower = text.toLowerCase();
	const out: Candidate[] = [];
	for (const { surface, note } of registered) {
		const trimmed = surface.trim();
		const al = trimmed.toLowerCase();
		if (!al) continue;
		const hit = al.includes(" ") ? lower.includes(al) : tokens.has(al);
		if (!hit) continue;
		out.push({ surface: trimmed, note, forced: true });
	}
	return out;
}

/**
 * True when an edited message's text/caption is empty or whitespace-only. Telegram
 * delivers no update for an actual message delete, so clearing the text is the user's
 * way of asking to remove the jot's journal line.
 */
export function isBlank(text: string): boolean {
	return text.trim().length === 0;
}

/**
 * Parse a literal edit instruction into an {old,new} swap, or null if freeform
 * (freeform goes to the agent). Supports `s/old/new/` and `replace X with Y`.
 */
export function parseLiteralEdit(
	msg: string,
): { old: string; new: string } | null {
	const s = msg.trim();
	const sed = s.match(/^s\/((?:\\.|[^/])+)\/((?:\\.|[^/])*)\/?$/);
	if (sed && sed[1] !== undefined && sed[2] !== undefined) {
		return {
			old: sed[1].replace(/\\\//g, "/"),
			new: sed[2].replace(/\\\//g, "/"),
		};
	}
	const repl = s.match(/^replace\s+"?(.+?)"?\s+with\s+"?(.+?)"?$/i);
	if (repl && repl[1] !== undefined && repl[2] !== undefined) {
		return { old: repl[1], new: repl[2] };
	}
	return null;
}

// --- Telegram admin-command formatting (pure; the commands do I/O, this shapes text) ---

// A Telegram message is hard-capped at 4096 characters — go over and the send is rejected
// outright, not trimmed. Any list built from an unbounded query therefore has to stop
// somewhere, and the rule for the three helpers below is that it always says where. A list
// that quietly drops its tail reads as complete and is the worse failure of the two.

/** Telegram's hard per-message character cap. */
export const TELEGRAM_LIMIT = 4096;

/** Last-resort guard on anything about to be sent: cut to the limit, visibly. Paginate at
 *  the source where you can — this only exists so an oversized message degrades to a
 *  labelled cut instead of a failed send. */
export function fitTelegram(text: string, limit = TELEGRAM_LIMIT): string {
	if (text.length <= limit) return text;
	const notice = `\n… cut here — the rest is past Telegram's ${limit}-character limit.`;
	return `${text.slice(0, limit - notice.length)}${notice}`;
}

/** Inline preview of a list: the first `max` entries, then a count of what's left out. */
export function previewList(items: string[], max: number): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")} … +${items.length - max} more`;
}

/** One page of a list, plus a footer naming the window and the command for the next page.
 *  `page` is 0-based and clamped; `cmd` is the command the footer tells the user to retype
 *  with a page number (e.g. "/rejections"). A single-page list gets no footer. */
export function formatListPage(
	items: string[],
	page: number,
	size: number,
	cmd: string,
	sep = "\n",
): string {
	const pages = Math.max(1, Math.ceil(items.length / size));
	const p = Math.min(Math.max(page, 0), pages - 1);
	const shown = items.slice(p * size, p * size + size);
	const body = shown.join(sep);
	if (pages === 1) return body;
	const from = p * size + 1;
	const nav =
		p + 1 < pages ? `next: ${cmd} ${p + 2}` : `back to the start: ${cmd} 1`;
	return `${body}\n\nShowing ${from}–${from + shown.length - 1} of ${items.length} · page ${p + 1}/${pages} · ${nav}`;
}

/** `<n> <word>` with a naive plural "s" suffix for anything but 1. */
export function pluralize(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Coarse human duration: "3d 4h", "5m 2s", "12s". */
export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${sec}s`;
	return `${sec}s`;
}

/** /stats body for a labelled window. */
export function formatStats(label: string, s: StatsRow): string {
	const tail = [
		s.inflight ? `in-flight ${s.inflight}` : "",
		s.failed ? `failed ${s.failed}` : "",
		s.abandoned ? `abandoned ${s.abandoned}` : "",
	].filter(Boolean);
	return [
		`📊 ${label}`,
		`Jots: ${s.total}`,
		`  text ${s.text} · voice ${s.audio} · image ${s.image} · video ${s.video}`,
		`Done ${s.done}${tail.length ? ` · ${tail.join(" · ")}` : ""}`,
	].join("\n");
}

export interface StatusView {
	counts: Record<JotStatus, number>;
	queueDepth: number;
	transcriber: string;
	links: { enabled: boolean; files: number; aliases: number };
	version: string;
	sha: string;
	uptimeMs: number;
}

/** /status body: health at a glance. */
export function formatStatus(v: StatusView): string {
	const c = v.counts;
	const links = v.links.enabled
		? `${v.links.files} files / ${v.links.aliases} aliases`
		: "disabled";
	return [
		`🩺 scriba ${v.version} (${v.sha.slice(0, 7)})`,
		`Uptime: ${formatDuration(v.uptimeMs)}`,
		`Jots: ${c.done} done · ${c.pending + c.processing} in-flight · ${c.failed} failed · ${c.abandoned} abandoned`,
		`Queue depth: ${v.queueDepth}`,
		`Transcriber: ${v.transcriber}`,
		`Link index: ${links}`,
	].join("\n");
}

/** GitHub Release bodies are conventional-changelog markdown: `### Section` headers and
 *  `* item ([#N](url)) ([sha](url))` bullets. Telegram gets plain text, not markdown, so
 *  this strips the `#`/`*` markers and the trailing commit/issue link refs, leaving
 *  `Section:` labels and `• item` bullets. */
function formatChangelogMarkdown(body: string): string {
	const out: string[] = [];
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = line.match(/^#{1,6}\s+(.*)/);
		if (heading) {
			if (out.length) out.push("");
			out.push(`${heading[1]!}:`);
			continue;
		}
		const item = line.match(/^[*-]\s+(.*)/);
		if (item) {
			const text = item[1]!.replace(/\s*\(\[[^\]]+\]\([^)]+\)\)/g, "").trim();
			out.push(`• ${text}`);
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

/** Release body + link, shared by the deploy notice and /changelog. */
function formatReleaseBody(note: ReleaseNote): string {
	const lines: string[] = [];
	const body = formatChangelogMarkdown(note.body).trim();
	if (body) lines.push(body);
	lines.push(note.url);
	return lines.join("\n\n");
}

/** Boot notice sent once when the running version/sha differs from the last known deploy.
 *  `note` is this version's GitHub Release (fetched live — see services/github.ts), so
 *  the deploy notice always shows what actually changed. Omitted when the lookup fails. */
export function formatDeployNotice(
	version: string,
	sha: string,
	note?: ReleaseNote | null,
): string {
	const header = `🚀 scriba deployed — ${version} (${sha.slice(0, 7)})`;
	return note ? [header, formatReleaseBody(note)].join("\n\n") : header;
}

/** /changelog body for one version. */
export function formatReleaseNote(note: ReleaseNote): string {
	return [`📋 ${note.name}`, formatReleaseBody(note)].join("\n\n");
}

/** /changelog N: a compact list of the N most recent releases. */
export function formatReleaseList(notes: ReleaseNote[]): string {
	if (!notes.length) return "no releases found";
	return notes
		.map(
			(n) => `• ${n.tag} (${plainDate(Date.parse(n.publishedAt))}) — ${n.url}`,
		)
		.join("\n");
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

/** Which wizard prompt a reply is answering, if any. */
export type WizardPrompt =
	| { kind: "sw" }
	| { kind: "rg" }
	| { kind: "rgn" }
	| { kind: "rgm" }
	| { kind: "rgw"; index: number }
	| { kind: "es" };

export function parseWizardRef(text: string): WizardPrompt | null {
	if (text.includes(WIZARD_ENTRYSIZE_REF)) return { kind: "es" };
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

/** Words out of a reply that may list several: newline- or comma-separated. Inner spaces
 *  are kept, so "Path Of Exile" is one word, not three. Trimmed, lowercased (surfaces are
 *  matched case-insensitively), deduped; empty and over-long fragments are dropped. */
export function parseRuleWords(text: string, limit = 20): string[] {
	const out = new Set<string>();
	for (const part of text.split(/[\n,]/)) {
		const word = part.trim().replace(/\s+/g, " ").toLowerCase();
		if (word && word.length <= 60) out.add(word);
		if (out.size >= limit) break;
	}
	return [...out];
}

/** A note title out of a typed reply: `[[wikilink]]` brackets and stray quotes stripped,
 *  whitespace collapsed. Empty means the caller should re-prompt. */
export function cleanNoteTitle(text: string): string {
	return text
		.trim()
		.replace(/^\[\[|\]\]$/g, "")
		.replace(/^["']|["']$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Notes matching `query`, best first, from the vault alias index — so the note side of a
 * rule is searched and tapped instead of typed from memory (the vault runs to thousands
 * of notes). Token-free: exact alias beats prefix beats substring, ties break on the
 * shorter alias (the more specific note), and each note appears once however many of its
 * aliases hit. The caller paginates; `limit` only caps how deep a vague query can dig.
 */
export function noteSuggestions(
	query: string,
	index: AliasEntry[],
	limit = 200,
): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const best = new Map<string, number>();
	for (const { note, alias } of index) {
		const a = alias.toLowerCase();
		const rank = a === q ? 0 : a.startsWith(q) ? 1 : a.includes(q) ? 2 : -1;
		if (rank < 0) continue;
		// alias length is the tiebreak, scaled so it can never outweigh the rank above
		const score = rank * 1000 + Math.min(alias.length, 999);
		const seen = best.get(note);
		if (seen === undefined || score < seen) best.set(note, score);
	}
	return [...best.entries()]
		.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([note]) => note);
}

/** Unique surfaces from an ordered rejection list, preserving the list's order. Powers
 *  the first step of the interactive /unreject menu. */
export function distinctSurfaces<T extends { surface: string }>(
	list: T[],
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of list) {
		if (seen.has(r.surface)) continue;
		seen.add(r.surface);
		out.push(r.surface);
	}
	return out;
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

/** From a set of jots (e.g. a /reprocess date/range query), the distinct ids to actually
 *  reprocess: a squashed follower's line lives on its leader's anchor, so a follower
 *  resolves to that leader's id rather than being reprocessed standalone. Order of first
 *  appearance is preserved. */
export function reprocessTargets(jots: Pick<Jot, "anchor">[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const j of jots) {
		if (seen.has(j.anchor)) continue;
		seen.add(j.anchor);
		out.push(j.anchor);
	}
	return out;
}
