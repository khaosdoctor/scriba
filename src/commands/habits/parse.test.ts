import assert from "node:assert/strict";
import { test } from "node:test";
import { completeHabitLine, parseHabitRef, parseHabits } from "./parse.ts";

const HABITS_NOTE = [
	"## Habits",
	"- [ ] Practiced music #meta/habits/music",
	"- [ ] [Pages read:: 0] #meta/habits/reading",
	"- [x] Exercised #meta/habits/exercise [completion:: 2026-06-22]",
	"## TIL",
	"- something",
].join("\n");

test("parseHabits reads bullets, done state, labels, and inline fields", () => {
	const habits = parseHabits(HABITS_NOTE);
	assert.equal(habits.length, 3);
	assert.deepEqual(
		habits.map((h) => [h.index, h.done, h.label, h.field]),
		[
			[0, false, "Practiced music", null],
			[1, false, "Pages read", { key: "Pages read", value: "0" }],
			[2, true, "Exercised", null], // completion is not the habit's own field
		],
	);
});

test("parseHabits stops at the next heading and returns [] when the section is absent", () => {
	assert.equal(parseHabits(HABITS_NOTE).length, 3); // doesn't swallow the ## TIL bullet
	assert.deepEqual(parseHabits("## Journal\n- [ ] x\n"), []);
	assert.equal(parseHabits("## Rituals\n- [ ] x\n", "Rituals").length, 1); // heading is configurable
});

test("completeHabitLine ticks a yes/no habit and stamps completion", () => {
	assert.equal(
		completeHabitLine("- [ ] Practiced music #meta/habits/music", "2026-06-22"),
		"- [x] Practiced music #meta/habits/music [completion:: 2026-06-22]",
	);
});

test("completeHabitLine fills the inline field value and stamps completion", () => {
	assert.equal(
		completeHabitLine(
			"- [ ] [Pages read:: 0] #meta/habits/reading",
			"2026-06-22",
			"42",
		),
		"- [x] [Pages read:: 42] #meta/habits/reading [completion:: 2026-06-22]",
	);
});

test("completeHabitLine is idempotent on an already-done line", () => {
	const done =
		"- [x] Exercised #meta/habits/exercise [completion:: 2026-06-22]";
	assert.equal(completeHabitLine(done, "2026-06-23"), done); // no double tick, no second completion
});

test("parseHabitRef extracts the day + index from a question, or null", () => {
	assert.deepEqual(
		parseHabitRef("🌱 Pages read? Reply with a value.\n(hb:2026-06-22:1)"),
		{
			date: "2026-06-22",
			index: 1,
		},
	);
	assert.equal(parseHabitRef("just a normal edit reply"), null);
});
