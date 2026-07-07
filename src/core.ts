/**
 * Pure, dependency-free helpers. Deterministic, token-free — unit-tested in isolation.
 * Stopwords and rejections are injected (they live in the DB), not hardcoded here.
 */
import { randomBytes } from "node:crypto";
import type { Jot, JotKind, JotStatus, StatsRow } from "./db.ts";
import { plainDate } from "./time.ts";

// ponytail: swap for RegExp.escape once TypeScript ships its typedef (5.9 lacks it).
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Fixed 8-char hex id, also used as the Obsidian block anchor. */
export function makeJotId(): string {
	return randomBytes(4).toString("hex");
}

/** One-line confirmation of what landed in the note. Attach-only jots carry no text. */
export function donePreview(kind: JotKind, textPart: string): string {
	const text = textPart.trim();
	if (text) return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	if (kind === "image" || kind === "video") return `${kind} saved to the note`;
	return "saved";
}

/** Escape the five characters that matter for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
	return s.replace(
		/[<>&"']/g,
		(c) =>
			({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[
				c
			]!,
	);
}

/** Final in-chat confirmation once a jot lands: the saved line blockquoted with its
 *  time so it stands out. HTML parse mode — content is escaped. */
export function doneMessage(
	time: string,
	kind: JotKind,
	textPart: string,
): string {
	return `✅ Saved to your journal\n<blockquote>🕒 ${time} · ${escapeHtml(donePreview(kind, textPart))}</blockquote>`;
}

/** Journal bullet in the vault's house style: `- _HH:MM:SS ::_ <text> ^anchor` */
export function journalLine(
	time: string,
	text: string,
	anchor: string,
): string {
	return `- _${time} ::_ ${text} ^${anchor}`;
}

/** Placeholder written the instant a jot arrives — fixes ordering, filled in later. */
export function placeholderLine(time: string, anchor: string): string {
	return journalLine(time, "⏳", anchor);
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
	new RegExp(`^.*\\^${escapeRe(anchor)}\\s*$`, "m");

/** Replace the whole line carrying `^anchor` with `newLine`. Returns null if not found. */
export function replaceAnchorLine(
	note: string,
	anchor: string,
	newLine: string,
): string | null {
	const re = anchorRe(anchor);
	if (!re.test(note)) return null;
	return note.replace(re, newLine);
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
	lines.push(`Text: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`);
	return lines.join("\n");
}
