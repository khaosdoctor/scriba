import assert from "node:assert/strict";
import { test } from "node:test";
import {
	completeTaskLine,
	detectionEnabled,
	draftFromDetection,
	effectiveStart,
	filterTasks,
	insertTaskLine,
	parseTaskDate,
	parseTaskDraft,
	parseTaskLine,
	parseTasks,
	renderTaskLine,
	type Task,
	taskButtonLabel,
	taskCard,
	uncompleteTaskLine,
	weekBounds,
} from "./parse.ts";

const WORK_TAG = "#type/todo/work";
const TAG = "#type/todo";

// Real lines out of the vault's two task notes — the parser has to survive exactly these.
const NOTE = [
	"# Todos",
	"",
	"## Daily agenda",
	"- [ ] not a task, wrong section #type/todo [due:: 2026-09-09]",
	"",
	"## Things to do",
	"- [ ] Buy cat sand (from [[2026-08-29]]) #type/todo [start:: 2026-08-30] [due:: 2026-09-02]",
	"- [x] finish the book #type/todo [start:: 2026-06-15] [due:: 2026-06-14] [completion:: 2026-06-23]",
	"- [-] _[[2026-03-03]] ::_ Hire the cleaning company for a deep clean #type/todo [start:: 2026-03-03] [due:: 2026-03-06] [cancelled:: 2026-03-03]",
	"- [x] _[[2026-03-01]] ::_ Hire insurance from hedvig #type/todo [start:: 2026-02-28] [due:: 2026-02-28] ✅ 2026-03-01",
	"- [x] _[[2026-03-01]] ::_ Export my credit card purchases #type/todo [start::6-03-01] [due:: 2026-03-01] ✅ 2026-03-02",
	"some prose, not a bullet",
	"- [ ] Get a DIY Guitar from [here](https://www.gear4music.se/en/Electric-Guitars/DIY-Guitars) #type/todo [due:: 2026-09-05]",
	"",
	"## Another section",
	"- [ ] also out of scope #type/todo",
].join("\n");

test("parseTasks reads only its own section, in order", () => {
	const tasks = parseTasks(NOTE, "Things to do", TAG, "personal");
	assert.equal(tasks.length, 6);
	assert.deepEqual(
		tasks.map((t) => t.state),
		["open", "done", "cancelled", "done", "done", "open"],
	);
	assert.deepEqual(
		tasks.map((t) => t.index),
		[0, 1, 2, 3, 4, 5],
	);
	assert.equal(tasks[0]!.text, "Buy cat sand (from [[2026-08-29]])");
	assert.equal(tasks[0]!.start, "2026-08-30");
	assert.equal(tasks[0]!.due, "2026-09-02");
	assert.equal(tasks[0]!.type, "personal");
});

test("parseTasks keeps wikilinks and markdown links in the description", () => {
	const tasks = parseTasks(NOTE, "Things to do", TAG, "personal");
	assert.equal(
		tasks[5]!.text,
		"Get a DIY Guitar from [here](https://www.gear4music.se/en/Electric-Guitars/DIY-Guitars)",
	);
	assert.equal(tasks[2]!.text.startsWith("_[[2026-03-03]] ::_ Hire"), true);
});

test("a completion is read from either notation, and a typo'd date is no date", () => {
	const tasks = parseTasks(NOTE, "Things to do", TAG, "personal");
	assert.equal(tasks[1]!.completion, "2026-06-23"); // [completion:: …]
	assert.equal(tasks[3]!.completion, "2026-03-01"); // legacy ✅
	assert.equal(tasks[4]!.start, null); // [start::6-03-01] is unusable
	assert.equal(tasks[4]!.due, "2026-03-01");
});

test("the work tag doesn't swallow the personal one, and vice versa", () => {
	const work =
		"- [x] Review imagescaler docker #type/todo/work [start:: 2026-07-09] [due:: 2026-07-09] [completion:: 2026-07-09]";
	const asWork = parseTaskLine(work, 0, "work", WORK_TAG)!;
	assert.equal(asWork.text, "Review imagescaler docker");
	// Parsed with the personal tag, the "/work" suffix is left behind rather than half-cut.
	assert.equal(
		parseTaskLine(work, 0, "personal", TAG)!.text,
		"Review imagescaler docker #type/todo/work",
	);
});

test("an empty description and extra fields survive parsing", () => {
	const t = parseTaskLine(
		"- [x] #type/todo/work [id:: ylpq51] [start:: 2026-03-04] [due:: 2026-03-04] [completion:: 2026-06-23]",
		0,
		"work",
		WORK_TAG,
	)!;
	assert.equal(t.text, "");
	assert.equal(t.completion, "2026-06-23");
	assert.equal(parseTaskLine("just prose", 0, "work", WORK_TAG), null);
});

test("renderTaskLine leaves start out when there isn't one", () => {
	assert.equal(
		renderTaskLine(
			{
				description: "Buy cat sand",
				type: "personal",
				start: null,
				due: "2026-09-02",
			},
			TAG,
			"2026-08-29",
		),
		"- [ ] Buy cat sand (from [[2026-08-29]]) #type/todo [due:: 2026-09-02]",
	);
	assert.equal(
		renderTaskLine(
			{
				description: "Review the RFC",
				type: "work",
				start: "2026-09-01",
				due: "2026-09-05",
			},
			WORK_TAG,
			"2026-08-29",
		),
		"- [ ] Review the RFC (from [[2026-08-29]]) #type/todo/work [start:: 2026-09-01] [due:: 2026-09-05]",
	);
});

test("a rendered line parses back to the draft it came from", () => {
	const draft = {
		description: "Buy cat sand",
		type: "personal" as const,
		start: "2026-08-30",
		due: "2026-09-02",
	};
	const back = parseTaskLine(
		renderTaskLine(draft, TAG, "2026-08-29"),
		0,
		"personal",
		TAG,
	)!;
	assert.equal(back.start, draft.start);
	assert.equal(back.due, draft.due);
	assert.equal(back.state, "open");
	assert.equal(back.text, "Buy cat sand (from [[2026-08-29]])");
});

test("completeTaskLine ticks and stamps once; uncomplete undoes both notations", () => {
	const open =
		"- [ ] Buy cat sand #type/todo [start:: 2026-08-30] [due:: 2026-09-02]";
	const done = completeTaskLine(open, "2026-08-31");
	assert.equal(
		done,
		"- [x] Buy cat sand #type/todo [start:: 2026-08-30] [due:: 2026-09-02] [completion:: 2026-08-31]",
	);
	assert.equal(completeTaskLine(done, "2026-09-05"), done); // idempotent
	assert.equal(uncompleteTaskLine(done), open);
	// The legacy ✅ marker is cleaned up the same way.
	assert.equal(
		uncompleteTaskLine(
			"- [x] Hire insurance #type/todo [due:: 2026-02-28] ✅ 2026-03-01",
		),
		"- [ ] Hire insurance #type/todo [due:: 2026-02-28]",
	);
	assert.equal(uncompleteTaskLine(open), open); // idempotent
});

test("completing a cancelled task drops its cancellation", () => {
	const done = completeTaskLine(
		"- [-] Hire the cleaning company #type/todo [due:: 2026-03-06] [cancelled:: 2026-03-03]",
		"2026-03-09",
	);
	assert.equal(
		done,
		"- [x] Hire the cleaning company #type/todo [due:: 2026-03-06] [completion:: 2026-03-09]",
	);
});

test("insertTaskLine respects each note's own order", () => {
	const note = [
		"## Things to do",
		"- [ ] one",
		"- [ ] two",
		"",
		"## Next",
	].join("\n");
	assert.match(
		insertTaskLine(note, "Things to do", "- [ ] new", "bottom"),
		/- \[ \] two\n- \[ \] new/,
	);
	assert.match(
		insertTaskLine(note, "Things to do", "- [ ] new", "top"),
		/## Things to do\n- \[ \] new\n- \[ \] one/,
	);
	assert.match(
		insertTaskLine(
			"## Other Tasks\n\n## Next",
			"Other Tasks",
			"- [ ] new",
			"top",
		),
		/## Other Tasks\n\n- \[ \] new/,
	);
	assert.throws(
		() => insertTaskLine(note, "Nowhere", "- [ ] new", "top"),
		/Nowhere/,
	);
});

// --- natural language ---

const TODAY = "2026-08-29"; // a Saturday

test("one date is the deadline", () => {
	const d = parseTaskDraft("buy cat sand next week", TODAY);
	assert.deepEqual(d, {
		description: "buy cat sand",
		type: "personal",
		start: null,
		due: "2026-09-05",
	});
});

test("cue words label the dates", () => {
	assert.deepEqual(parseTaskDraft("review the RFC by next friday", TODAY), {
		description: "review the RFC",
		type: "personal",
		start: null,
		due: "2026-09-04",
	});
	assert.deepEqual(
		parseTaskDraft("book flights starting next monday due in two weeks", TODAY),
		{
			description: "book flights",
			type: "personal",
			start: "2026-08-31",
			due: "2026-09-12",
		},
	);
});

test("a lone start is promoted to the deadline, since due is the mandatory one", () => {
	const d = parseTaskDraft("start the chapter on monday", TODAY);
	assert.equal(d.start, null);
	assert.equal(d.due, "2026-08-31");
	assert.equal(d.description, "start the chapter");
});

test("work is only work when it's said plainly", () => {
	assert.equal(
		parseTaskDraft("review the RFC for work tomorrow", TODAY).type,
		"work",
	);
	assert.equal(parseTaskDraft("answer the RFCs at work", TODAY).type, "work");
	assert.equal(
		parseTaskDraft("work on the guitar solo", TODAY).type,
		"personal",
	);
	assert.equal(
		parseTaskDraft("work out why the tests fail", TODAY).type,
		"personal",
	);
	assert.equal(
		parseTaskDraft("review the RFC for work tomorrow", TODAY).description,
		"review the RFC",
	);
});

test("a task with no date at all keeps its whole text", () => {
	assert.deepEqual(parseTaskDraft("buy milk", TODAY), {
		description: "buy milk",
		type: "personal",
		start: null,
		due: null,
	});
	// A bare clock time is not a date — it stays in the description.
	assert.equal(parseTaskDraft("gym at 7pm", TODAY).due, null);
});

test("parseTaskDate takes a phrase, an ISO day, or a clear instruction", () => {
	assert.equal(parseTaskDate("next friday", TODAY), "2026-09-04");
	assert.equal(parseTaskDate("2026-12-24", TODAY), "2026-12-24");
	assert.equal(parseTaskDate("in three days", TODAY), "2026-09-01");
	assert.equal(parseTaskDate("none", TODAY), null);
	assert.equal(parseTaskDate("banana", TODAY), undefined);
	assert.equal(parseTaskDate("", TODAY), undefined);
});

// --- views ---

const task = (over: Partial<Task>): Task => ({
	index: 0,
	line: "",
	fingerprint: "0",
	type: "personal",
	state: "open",
	text: "t",
	start: null,
	due: null,
	completion: null,
	...over,
});

test("weekBounds is the Sunday-first week around a day", () => {
	assert.deepEqual(weekBounds("2026-08-29"), ["2026-08-23", "2026-08-29"]);
	assert.deepEqual(weekBounds("2026-08-30"), ["2026-08-30", "2026-09-05"]);
});

test("the list presets mirror the vault's task queries", () => {
	const tasks = [
		task({ index: 0, due: "2026-08-20", text: "overdue" }),
		task({ index: 1, due: "2026-08-29", text: "today" }),
		task({ index: 2, due: "2026-09-02", text: "this week-ish" }),
		task({ index: 3, due: "2026-10-30", text: "far off" }),
		task({
			index: 4,
			state: "done",
			completion: "2026-08-01",
			text: "old done",
		}),
		task({
			index: 5,
			state: "done",
			completion: "2026-08-28",
			text: "new done",
		}),
		task({
			index: 6,
			state: "cancelled",
			due: "2026-08-29",
			text: "cancelled",
		}),
		task({
			index: 7,
			start: "2026-08-29",
			due: "2026-11-01",
			text: "starts today",
		}),
	];
	const texts = (v: Parameters<typeof filterTasks>[1]) =>
		filterTasks(tasks, v, TODAY).map((t) => t.text);
	assert.deepEqual(texts("open"), [
		"overdue",
		"today",
		"this week-ish",
		"far off",
		"starts today",
	]);
	assert.deepEqual(texts("overdue"), ["overdue"]);
	// The morning summary's view: due today, still due from before, or starting today.
	assert.deepEqual(texts("day"), ["overdue", "today", "starts today"]);
	assert.deepEqual(texts("today"), ["today", "starts today"]);
	assert.deepEqual(texts("future"), [
		"today",
		"this week-ish",
		"far off",
		"starts today",
	]);
	assert.deepEqual(texts("two"), ["today", "this week-ish"]);
	assert.deepEqual(texts("done"), ["new done", "old done"]); // newest completion first
	// "this week" is Sun 23rd–Sat 29th: the overdue one is out, a task starting today is in.
	assert.deepEqual(texts("week"), ["today", "starts today"]);
});

test("effectiveStart falls back to the deadline", () => {
	assert.equal(effectiveStart(task({ due: "2026-09-02" })), "2026-09-02");
	assert.equal(
		effectiveStart(task({ start: "2026-08-30", due: "2026-09-02" })),
		"2026-08-30",
	);
});

test("the card and the row labels say what's missing", () => {
	const card = taskCard({
		description: "Buy cat sand",
		type: "personal",
		start: null,
		due: null,
	});
	assert.match(card, /Due: — <i>\(needed\)<\/i>/);
	assert.match(card, /🏠 Personal/);
	assert.match(card, /Start: —/); // a task with no planned start says so
	assert.match(
		taskCard({
			description: "x",
			type: "work",
			start: "2026-09-01",
			due: "2026-09-02",
		}),
		/Start: 2026-09-01/,
	);
	assert.equal(
		taskButtonLabel(task({ text: "a".repeat(50) }), 3, 10),
		`☐ 3. ${"a".repeat(9)}…`,
	);
});

// --- detection ---

test("a detected task's own words become dates against the jot's day", () => {
	assert.deepEqual(
		draftFromDetection(
			{ description: "Call the vet", due: "tomorrow", type: "personal" },
			TODAY,
		),
		{
			description: "Call the vet",
			type: "personal",
			start: null,
			due: "2026-08-30",
		},
	);
	// A date left inside the description is lifted out of it rather than read twice.
	assert.deepEqual(
		draftFromDetection({ description: "Call the vet tomorrow" }, TODAY),
		{
			description: "Call the vet",
			type: "personal",
			start: null,
			due: "2026-08-30",
		},
	);
	// A start with no deadline is promoted, since the deadline is the mandatory one.
	assert.deepEqual(
		draftFromDetection(
			{ description: "Book the flights", start: "next monday", type: "work" },
			TODAY,
		),
		{
			description: "Book the flights",
			type: "work",
			start: null,
			due: "2026-08-31",
		},
	);
});

test("a detected task with no timing at all keeps none — the card asks", () => {
	const d = draftFromDetection({ description: "Renew the passport" }, TODAY);
	assert.equal(d.due, null);
	assert.equal(d.start, null);
	// Nonsense the model may put in a date field is dropped, not guessed at.
	assert.equal(
		draftFromDetection(
			{ description: "Renew the passport", due: "soon-ish" },
			TODAY,
		).due,
		null,
	);
	// An unknown type falls back to what the text says (personal by default).
	assert.equal(
		draftFromDetection(
			{ description: "Renew the passport", type: "other" },
			TODAY,
		).type,
		"personal",
	);
});

test("detection is on unless it was switched off", () => {
	assert.equal(detectionEnabled(undefined), true);
	assert.equal(detectionEnabled("on"), true);
	assert.equal(detectionEnabled("off"), false);
});
