/**
 * Pure, dependency-free task helpers. Deterministic, token-free — unit-tested in
 * parse.test.ts. No network or side effects (the same discipline as core.ts, kept here so
 * all the task code lives in one folder, like the habits flow).
 *
 * A task is a checklist bullet under a heading in one of the two task notes:
 *   - [ ] Buy cat sand (from [[2026-08-29]]) #type/todo [start:: 2026-08-30] [due:: 2026-09-02]
 *   - [x] Review the RFC #type/todo/work [start:: 2026-08-06] [due:: 2026-08-08] [completion:: 2026-08-08]
 *   - [-] Hire the cleaning company #type/todo [start:: 2026-03-03] [cancelled:: 2026-03-03]
 *
 * `[due::]` is the deadline and is mandatory; `[start::]` is the planned start and is
 * optional to *say* — a task given only a deadline starts on it, so both fields are always
 * written. Older rows carry `✅ 2026-03-02` instead of `[completion:: …]`
 * (the Tasks plugin's own shorthand): those are read as done and cleaned up on untick,
 * but never written.
 */

import { createHash } from "node:crypto";
import * as chrono from "chrono-node";
import { escapeHtml, escapeRe } from "../../core.ts";
import type { TaskType } from "../../db.ts";
import { DATE_RE, dateFromIso, plainDate } from "../../time.ts";

export type { TaskType } from "../../db.ts";
/** `- [ ]` open, `- [x]` done, `- [-]` cancelled (terminal, never listed or reopened). */
export type TaskState = "open" | "done" | "cancelled";

export interface Task {
	/** Position among the checklist bullets of its section, stable regardless of state. */
	index: number;
	/** The full raw bullet line, exactly as it sits in the note. */
	line: string;
	/** Short digest of `line`, carried in callback data so a tap that lands after the note
	 *  changed underneath is refused instead of ticking whatever now sits at that index. */
	fingerprint: string;
	type: TaskType;
	state: TaskState;
	/** The description: the bullet minus its checkbox, tag and inline fields. */
	text: string;
	start: string | null;
	due: string | null;
	completion: string | null;
}

/** A task being composed — in task mode, or proposed from a jot — before it's written. */
export interface TaskDraft {
	description: string;
	type: TaskType;
	start: string | null;
	due: string | null;
}

/** What a task is unless something plainly says otherwise. A bare "work" is a verb as often
 *  as a category, and getting it wrong puts the task in the wrong note — so anything that
 *  isn't clearly work is personal, and the type button is one tap. */
export const DEFAULT_TASK_TYPE: TaskType = "personal";

export const TYPE_LABEL: Record<TaskType, string> = {
	work: "🏢 Work",
	personal: "🏠 Personal",
};

export const STATE_ICON: Record<TaskState, string> = {
	open: "☐",
	done: "☑",
	cancelled: "⊘",
};

/** Is this one of the two task types? Guards a value off a callback or the model. */
export function isTaskType(v: unknown): v is TaskType {
	return v === "work" || v === "personal";
}

// --- line parsing -----------------------------------------------------------------------

// `[due:: 2026-09-02]` → key "due", value "2026-09-02". The key class excludes brackets so
// a `[[wikilink]]` or a `[label](url)` inside the description can never look like a field.
const FIELD_RE = /\[\s*([^[\]:]+?)\s*::\s*([^\]]*?)\s*\]/g;
// The Tasks plugin's own done marker, on older rows only.
const LEGACY_DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const CHECKBOX_RE = /^(\s*-\s*)\[([ xX\-/])\]\s?(.*)$/;

const STATE_BY_MARK: Record<string, TaskState> = {
	" ": "open",
	x: "done",
	X: "done",
	"-": "cancelled",
	"/": "open", // in-progress in some themes; still something to do
};

/** Every inline `[key:: value]` on a line, keyed by lowercased key. */
function fields(line: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of line.matchAll(FIELD_RE))
		out.set(m[1]!.trim().toLowerCase(), m[2]!.trim());
	return out;
}

/** A field's value when it's a real calendar date, else null — the vault has at least one
 *  typo'd `[start::6-03-01]`, and a half-parsed date is worse than none. */
function dateField(f: Map<string, string>, key: string): string | null {
	const v = f.get(key);
	return v && DATE_RE.test(v) ? v : null;
}

/** Short digest of a line, for the stale-tap check. */
export function fingerprint(line: string): string {
	return createHash("sha1").update(line).digest("hex").slice(0, 8);
}

/** The description: the bullet's body minus its inline fields, its legacy done marker and
 *  its own tag. Other tags, `[[wikilinks]]` and markdown links are part of the text. */
function taskText(body: string, tag: string): string {
	return body
		.replace(FIELD_RE, "")
		.replace(LEGACY_DONE_RE, "")
		.replace(new RegExp(`${escapeRe(tag)}(?=\\s|$)`, "g"), "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Parse one bullet, or null when the line isn't a checklist bullet at all. */
export function parseTaskLine(
	line: string,
	index: number,
	type: TaskType,
	tag: string,
): Task | null {
	const m = line.match(CHECKBOX_RE);
	if (!m) return null;
	const f = fields(line);
	const legacy = line.match(LEGACY_DONE_RE)?.[1] ?? null;
	return {
		index,
		line,
		fingerprint: fingerprint(line),
		type,
		state: STATE_BY_MARK[m[2]!] ?? "open",
		text: taskText(m[3]!, tag),
		start: dateField(f, "start"),
		due: dateField(f, "due"),
		completion: dateField(f, "completion") ?? legacy,
	};
}

/** Bounds of the `## <heading>` section: [firstLineAfterHeading, endExclusive), or null
 *  when the note has no such heading. The section ends at the next heading of any level. */
function sectionBounds(
	lines: string[],
	heading: string,
): [number, number] | null {
	const headingRe = new RegExp(`^#{1,6}\\s+${escapeRe(heading)}\\s*$`);
	const start = lines.findIndex((l) => headingRe.test(l));
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++)
		if (/^#{1,6}\s/.test(lines[i]!)) {
			end = i;
			break;
		}
	return [start + 1, end];
}

/** Every task under `heading`, in note order. Non-bullet lines are skipped. */
export function parseTasks(
	note: string,
	heading: string,
	tag: string,
	type: TaskType,
): Task[] {
	const lines = note.split("\n");
	const bounds = sectionBounds(lines, heading);
	if (!bounds) return [];
	const out: Task[] = [];
	for (let i = bounds[0]; i < bounds[1]; i++) {
		const task = parseTaskLine(lines[i]!, out.length, type, tag);
		if (task) out.push(task);
	}
	return out;
}

// --- writing ----------------------------------------------------------------------------

/** Render a new task bullet. A task you didn't give a start date starts on its deadline —
 *  `effectiveStart` is the one place that rule lives, so the line, the card and the
 *  "starts this week" view all agree. The `(from [[date]])` records the day it came from:
 *  the jot's own day for one scriba spotted in the journal, today for one typed in task
 *  mode. */
export function renderTaskLine(
	draft: TaskDraft,
	tag: string,
	sourceDate?: string,
): string {
	const start = draft.start ?? draft.due;
	const from = sourceDate ? ` (from [[${sourceDate}]])` : "";
	const parts = [`- [ ] ${draft.description.trim()}${from}`, tag];
	if (start) parts.push(`[start:: ${start}]`);
	if (draft.due) parts.push(`[due:: ${draft.due}]`);
	return parts.join(" ");
}

/** Tick a task and stamp `[completion:: date]` (once). Idempotent on an already-done line;
 *  a cancelled line loses its `[cancelled:: …]`, since it isn't cancelled any more. */
export function completeTaskLine(line: string, date: string): string {
	const out = line
		.replace(/^(\s*-\s*)\[[ \-/]\]/, "$1[x]")
		.replace(/\s*\[\s*cancelled\s*::[^\]]*\]/gi, "");
	if (/\[\s*completion\s*::/i.test(out) || LEGACY_DONE_RE.test(out)) return out;
	return `${out.replace(/\s*$/, "")} [completion:: ${date}]`;
}

/** Untick a task and drop its completion stamp, in either notation. Idempotent. */
export function uncompleteTaskLine(line: string): string {
	return line
		.replace(/^(\s*-\s*)\[[xX]\]/, "$1[ ]")
		.replace(/\s*\[\s*completion\s*::[^\]]*\]/gi, "")
		.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, "")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\s+$/, "");
}

/**
 * Insert a task bullet into the `## <heading>` section, keeping that note's own order:
 * "top" goes above the first bullet (the work note's newest-first list), "bottom" after the
 * last one (the personal note's append-only list). A section with no bullets yet takes the
 * line directly under its heading. Throws when the heading is missing rather than writing
 * the task somewhere it will never be found again.
 */
export function insertTaskLine(
	note: string,
	heading: string,
	line: string,
	position: "top" | "bottom",
): string {
	const lines = note.split("\n");
	const bounds = sectionBounds(lines, heading);
	if (!bounds) throw new Error(`no "${heading}" heading in the note`);
	const [from, end] = bounds;
	const bullets: number[] = [];
	for (let i = from; i < end; i++)
		if (/^\s*-\s/.test(lines[i]!)) bullets.push(i);
	const at = bullets.length
		? position === "top"
			? bullets[0]!
			: bullets[bullets.length - 1]! + 1
		: skipBlank(lines, from, end);
	lines.splice(at, 0, line);
	return lines.join("\n");
}

/**
 * Replace the bullet sitting at `index` of the section with `newLine`, but only when the
 * line still digests to `expected` — a list rendered minutes ago indexes into a note that
 * may have been edited in Obsidian since, and ticking whatever now sits at that position
 * is the one mistake this must never make. Returns null when the section, the index or the
 * fingerprint no longer resolves, so the caller can answer "expired" instead.
 */
export function replaceTaskLineAt(
	note: string,
	heading: string,
	index: number,
	expected: string,
	newLine: string,
): string | null {
	const lines = note.split("\n");
	const bounds = sectionBounds(lines, heading);
	if (!bounds) return null;
	let n = 0;
	for (let i = bounds[0]; i < bounds[1]; i++) {
		if (!CHECKBOX_RE.test(lines[i]!)) continue;
		if (n++ !== index) continue;
		if (fingerprint(lines[i]!) !== expected) return null;
		lines[i] = newLine;
		return lines.join("\n");
	}
	return null;
}

/** First non-blank line at or after `from` inside the section (else the section's end). */
function skipBlank(lines: string[], from: number, end: number): number {
	let i = from;
	while (i < end && lines[i]!.trim() === "") i++;
	return i;
}

// --- natural language -------------------------------------------------------------------
// Turning "review the RFC by next friday" into a description plus two dates is token-free:
// chrono-node finds the date spans (the same parser linkDateWords already uses for the
// journal), and the cue word in front of each span says which date it is. Anything it gets
// wrong is one tap away on the confirmation card, which is why this never needs a model.

/** The languages a task might be typed in: the vault is English, but a task typed into
 *  Telegram is typed in whatever language it came to mind in, and chrono only reads the
 *  locale you hand it. English first (it's the common case and the least surprising), then
 *  the two the owner actually writes in. The first locale to find a real date wins, so a
 *  sentence is never half-read by two parsers. */
const LOCALES = [chrono.en.casual, chrono.pt.casual, chrono.sv.casual];

const START_CUES = [
	"start",
	"starts",
	"starting",
	"begin",
	"begins",
	"beginning",
	"from",
	// pt / sv
	"começa",
	"comeca",
	"começo",
	"comeco",
	"iniciar",
	"início",
	"inicio",
	"desde",
	"börjar",
	"borjar",
	"från",
	"fran",
];
const DUE_CUES = [
	"due",
	"by",
	"deadline",
	"until",
	"till",
	"before",
	"end",
	"ends",
	"ending",
	"finish",
	"finishes",
	"for",
	// pt / sv
	"até",
	"ate",
	"prazo",
	"vence",
	"entregar",
	"terminar",
	"senast",
	"till",
	"innan",
];
/** Phrases that mean "this one is work". Deliberately narrow: a bare "work" is a verb as
 *  often as a category ("work on the guitar"), and the type toggle is one tap. */
const WORK_CUE =
	/(^|\s)(for work|at work|work task|work-related|work related|@work|#work|job)(\s|$|[.,;!?])/i;
const PERSONAL_CUE =
	/(^|\s)(personal|at home|@personal|#personal)(\s|$|[.,;!?])/i;
/** Left over once the dates and cues come out ("pay rent by the end of" → "pay rent"). */
// `\b` is ASCII-only in JS, so it doesn't close a word ending in "é" or "å" — the
// boundaries here are Unicode letter/digit lookarounds instead, or "até" and "på" would
// never be recognised as the filler they are.
const TAIL_FILLER =
	/[\s,.;:—-]*(?<![\p{L}\p{N}])(by|due|on|at|in|from|starting|start|starts|begin|begins|until|till|before|the|end|ends|of|for|and|then|to|até|ate|para|pra|em|na|no|de|do|da|dia|que|senast|innan|på|pa|den|i)(?![\p{L}\p{N}])[\s,.;:—-]*$/iu;

/** A chrono hit that pins down an actual day, rather than a bare clock time ("at 7pm"). */
function isDateLike(r: chrono.ParsedResult): boolean {
	return (
		(r.start.isCertain("day") ||
			r.start.isCertain("weekday") ||
			r.start.isCertain("month")) &&
		!r.start.tags().has("casualReference/now")
	);
}

/** Date spans in a line, from the first locale that finds any. A bare clock time is not a
 *  date and never counts (see isDateLike). */
function dateHits(text: string, ref: Date): chrono.ParsedResult[] {
	for (const parser of LOCALES) {
		const hits = parser
			.parse(text, ref, { forwardDate: true })
			.filter(isDateLike);
		if (hits.length) return hits;
	}
	return [];
}

/** The cue word immediately before a date span, if there is one. */
function cueBefore(text: string, index: number): "start" | "due" | null {
	const before = text.slice(Math.max(0, index - 16), index).toLowerCase();
	// Unicode-aware: the cue may be "até" or "från", whose last letter [a-z] doesn't match.
	const word = before.match(/(\p{L}+)[\s,:-]*$/u)?.[1];
	if (!word) return null;
	if (START_CUES.includes(word)) return "start";
	if (DUE_CUES.includes(word)) return "due";
	return null;
}

/** Strip trailing filler left behind by removing a date span, repeatedly. */
function trimTail(s: string): string {
	let out = s.trim();
	for (;;) {
		const next = out.replace(TAIL_FILLER, "").trim();
		if (next === out) return out.replace(/[\s,;:]+$/, "").trim();
		out = next;
	}
}

/**
 * Split "buy cat sand next week" into `{ description, type, start, due }`. One date found
 * is the **due** date (the mandatory one); two unlabelled dates read as start then due,
 * earliest first. `today` anchors relative phrases — the jot's own day for a task spotted
 * in the journal, so "tomorrow" means the day after the entry, not after processing.
 */
export function parseTaskDraft(text: string, today = plainDate()): TaskDraft {
	const ref = dateFromIso(today);
	const hits = dateHits(text, ref);

	let start: string | null = null;
	let due: string | null = null;
	const consumed: [number, number][] = [];
	const unlabelled: { date: string; span: [number, number] }[] = [];

	for (const r of hits) {
		const date = plainDate(r.start.date().getTime());
		const cue = cueBefore(text, r.index);
		const span: [number, number] = [r.index, r.index + r.text.length];
		if (cue === "start" && !start) {
			start = date;
			consumed.push(span);
		} else if (cue === "due" && !due) {
			due = date;
			consumed.push(span);
		} else if (!cue) {
			unlabelled.push({ date, span });
		}
	}
	// Unlabelled dates fill what's still empty: one becomes the deadline, two read as a
	// start followed by a due date.
	if (unlabelled.length === 1 && !due) {
		due = unlabelled[0]!.date;
		consumed.push(unlabelled[0]!.span);
	} else if (unlabelled.length >= 2) {
		const [a, b] =
			unlabelled[0]!.date <= unlabelled[1]!.date
				? [unlabelled[0]!, unlabelled[1]!]
				: [unlabelled[1]!, unlabelled[0]!];
		if (!start) {
			start = a.date;
			consumed.push(a.span);
		}
		if (!due) {
			due = b.date;
			consumed.push(b.span);
		}
	}

	// A start with no deadline can't stand on its own (due is the mandatory one), so a lone
	// date read as a start is promoted rather than leaving the task undateable.
	if (start && !due) {
		due = start;
		start = null;
	}

	let description = text;
	for (const [s, e] of consumed.sort((x, y) => y[0] - x[0]))
		description = `${description.slice(0, s)} ${description.slice(e)}`;

	const type: TaskType =
		WORK_CUE.test(text) && !PERSONAL_CUE.test(text)
			? "work"
			: DEFAULT_TASK_TYPE;
	description = description
		.replace(WORK_CUE, " ")
		.replace(PERSONAL_CUE, " ")
		.replace(/\s+/g, " ");

	return { description: trimTail(description), type, start, due };
}

/** A date typed into one of the change prompts: "none" clears it, an explicit YYYY-MM-DD is
 *  taken as-is, anything else goes through chrono ("next friday", "in two weeks"). Returns
 *  `undefined` when it can't be read at all, so the caller can re-prompt. */
export function parseTaskDate(
	text: string,
	today = plainDate(),
): string | null | undefined {
	const s = text.trim();
	const lower = s.toLowerCase();
	if (!s) return undefined;
	if (["none", "clear", "no", "-", "remove", "off"].includes(lower))
		return null;
	if (DATE_RE.test(s)) return s;
	const hit = dateHits(s, dateFromIso(today))[0];
	return hit ? plainDate(hit.start.date().getTime()) : undefined;
}

// --- detection ---
// The enricher already reads every entry, so spotting "I need to book the flights" costs
// no extra call: it comes back in the same JSON as the wikilinks. What it must NOT do is
// date arithmetic — it reports the author's own words ("next friday") and chrono resolves
// them here, against the jot's own day.

/** `settings` key for the jot → task suggestions (set from the task menu, survives a
 *  restart). Unset means on: suggesting is the point of having the feature. */
export const TASK_DETECTION_KEY = "taskDetection";

/** Whether detection is on, from the raw setting value. */
export function detectionEnabled(raw: string | undefined): boolean {
	return raw !== "off";
}

/** One date phrase as the model copied it out of the entry. */
function phraseDate(phrase: string | undefined, today: string): string | null {
	if (!phrase?.trim()) return null;
	return parseTaskDate(phrase, today) ?? null;
}

/**
 * Turn a detected task into a draft. The description goes through the same deterministic
 * split task mode uses, so a date the model left in the sentence is lifted out of it rather
 * than read twice, and its dates stand in when the model reported none.
 */
export function draftFromDetection(
	detected: {
		description: string;
		start?: string;
		due?: string;
		type?: string;
	},
	jotDate: string,
): TaskDraft {
	const base = parseTaskDraft(detected.description, jotDate);
	let start = phraseDate(detected.start, jotDate) ?? base.start;
	let due = phraseDate(detected.due, jotDate) ?? base.due;
	// The deadline is the mandatory one, so a lone start becomes it (as in parseTaskDraft).
	if (!due && start) {
		due = start;
		start = null;
	}
	return {
		description: base.description || detected.description.trim(),
		// The model only gets to say "work" — anything else it comes back with, including
		// nothing at all, falls to what the text itself says, and that defaults to personal.
		type: detected.type === "work" ? "work" : base.type,
		start,
		due,
	};
}

// --- views ------------------------------------------------------------------------------
// The list presets mirror the Tasks-plugin queries in the vault's own dashboard: overdue is
// "due before today", today is "due on today", and the week views count from the current
// week. All of them are "not done" — a cancelled task is as finished as a done one.

/** A task's effective start: the planned start, or the deadline when there isn't one. */
export function effectiveStart(t: Task): string | null {
	return t.start ?? t.due;
}

export function isOpen(t: Task): boolean {
	return t.state === "open";
}

/** Sunday-first bounds of the week containing `date`, as [start, end] ISO days — the same
 *  week the /reprocess calendar draws and what the Tasks plugin's "this week" means. */
export function weekBounds(date: string): [string, string] {
	const d = dateFromIso(date);
	const start = new Date(
		d.getFullYear(),
		d.getMonth(),
		d.getDate() - d.getDay(),
	);
	const end = new Date(
		start.getFullYear(),
		start.getMonth(),
		start.getDate() + 6,
	);
	return [plainDate(start.getTime()), plainDate(end.getTime())];
}

/** `date` shifted by `days`, as an ISO day. */
export function shiftDate(date: string, days: number): string {
	const d = dateFromIso(date);
	return plainDate(
		new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime(),
	);
}

export type TaskView =
	| "day"
	| "open"
	| "future"
	| "overdue"
	| "today"
	| "week"
	| "two"
	| "done";

/** One list preset. `today` is passed in rather than read, so the views are testable. */
export function filterTasks(
	tasks: Task[],
	view: TaskView,
	today = plainDate(),
): Task[] {
	if (view === "done") {
		return tasks
			.filter((t) => t.state === "done")
			.sort((a, b) => (b.completion ?? "").localeCompare(a.completion ?? ""));
	}
	const [weekStart, weekEnd] = weekBounds(today);
	const inWeek = (d: string | null) => !!d && d >= weekStart && d <= weekEnd;
	const twoWeeks = shiftDate(today, 14);
	const open = tasks.filter(isOpen);
	const picked = open.filter((t) => {
		switch (view) {
			// What is actually on the plate right now: due today, still due from before, or
			// planned to start today. The daily summary is this view.
			case "day":
				return (!!t.due && t.due <= today) || effectiveStart(t) === today;
			case "open":
				return true;
			case "future":
				return !!t.due && t.due >= today;
			case "overdue":
				return !!t.due && t.due < today;
			case "today":
				return t.due === today || effectiveStart(t) === today;
			case "week":
				return inWeek(t.due) || inWeek(effectiveStart(t));
			case "two":
				return !!t.due && t.due >= today && t.due <= twoWeeks;
			default:
				return false;
		}
	});
	// Soonest deadline first; a task with no deadline sinks to the bottom.
	return picked.sort(
		(a, b) =>
			(a.due ?? "9999-99-99").localeCompare(b.due ?? "9999-99-99") ||
			(effectiveStart(a) ?? "").localeCompare(effectiveStart(b) ?? "") ||
			a.text.localeCompare(b.text),
	);
}

/** Header for a list view, so a screen says what it's showing. */
export const VIEW_LABEL: Record<TaskView, string> = {
	day: "🌅 Today and overdue",
	open: "📋 All open tasks",
	future: "🔭 Open tasks ahead",
	overdue: "⏰ Overdue",
	today: "📅 Due today",
	week: "🗓 This week",
	two: "📆 Next two weeks",
	done: "✅ Done",
};

/** One task as a chat line: its state, its dates and its text. HTML parse mode. Long
 *  descriptions are clipped — a real one runs to a few hundred characters, and eight of
 *  those would push the message past what Telegram accepts. */
export function taskListLine(
	t: Task,
	n: number,
	today = plainDate(),
	max = 160,
): string {
	const late = t.state === "open" && t.due && t.due < today ? " ⚠️" : "";
	const dates =
		t.state === "done"
			? t.completion
				? ` · done ${t.completion}`
				: ""
			: t.due
				? ` · due ${t.due}${late}`
				: "";
	const started =
		t.state === "open" && t.start && t.start !== t.due
			? ` · starts ${t.start}`
			: "";
	const full = t.text || "(no description)";
	const text = full.length > max ? `${full.slice(0, max - 1)}…` : full;
	return `${n}. ${STATE_ICON[t.state]} ${escapeHtml(text)}${dates}${started} <i>${t.type === "work" ? "work" : "personal"}</i>`;
}

/** Button label for a task row — short enough to survive Telegram's button width. */
export function taskButtonLabel(t: Task, n: number, max = 34): string {
	const text = (t.text || "(no description)").replace(/\s+/g, " ");
	const body = text.length > max ? `${text.slice(0, max - 1)}…` : text;
	return `${STATE_ICON[t.state]} ${n}. ${body}`;
}

/** The confirmation card: what will be written, before anything is. HTML parse mode. */
export function taskCard(draft: TaskDraft, header = "📝 New task"): string {
	return [
		header,
		"",
		`<b>${escapeHtml(draft.description || "(no description yet)")}</b>`,
		"",
		`Type: ${TYPE_LABEL[draft.type]}`,
		`Start: ${draft.start ?? draft.due ?? "—"}`,
		`Due: ${draft.due ?? "— <i>(needed)</i>"}`,
	].join("\n");
}
