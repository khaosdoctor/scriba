import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../db.ts";
import { MAX_ATTEMPTS } from "../db.ts";
import { JotProcessor } from "./processor.ts";

/** Status messages the bot was asked to post, with the buttons each one carried. */
type Posted = { id: string; html: string; opts: any };

const jot = (over: Partial<Jot> = {}): Jot =>
	({
		id: "abcd1234",
		anchor: "abcd1234",
		kind: "text",
		status: "processing",
		attempts: 0,
		raw_text: "a thought",
		transcript: null,
		asset_path: null,
		file_id: null,
		note_path: "notes/daily notes/2026-08-16.md",
		time: "10:00:00",
		error: null,
		...over,
	}) as Jot;

/** A processor whose collaborators only record what they were asked to do. The note write
 *  throws, which is the give-up path's own escape hatch — it keeps the stubs to the parts
 *  under test. */
function harness(
	over: { followers?: Jot[]; detection?: string; priorDrafts?: number } = {},
) {
	const posted: Posted[] = [];
	const reactions: [string, string][] = [];
	const updates: [string, any][] = [];
	const repo = {
		updateJot: async (id: string, patch: any) => void updates.push([id, patch]),
		groupFollowers: async () => over.followers ?? [],
		getSetting: async () => over.detection,
		taskDraftsForJot: async () => over.priorDrafts ?? 0,
	};
	const obsidian = {
		ensureDailyNote: async () => {
			throw new Error("obsidian is down");
		},
	};
	const bot = {
		status: async (id: string, html: string, opts?: any) => {
			posted.push({ id, html, opts });
		},
		react: async (id: string, state: string) =>
			void reactions.push([id, state]),
		deleteStatus: async () => {},
		onJotDone: async () => {},
	};
	const processor: any = new JotProcessor(
		repo as any,
		obsidian as any,
		{} as any,
		{} as any,
		{} as any,
		bot as any,
	);
	return { processor, posted, reactions, updates };
}

/** Which buttons a status message asked for. */
const buttons = (p: Posted | undefined) => ({
	retry: !!p?.opts?.retry,
	discard: !!p?.opts?.discard,
});

test("a transient failure says so on the jot's message, with both buttons", async () => {
	const { processor, posted, reactions, updates } = harness();
	await processor.fail(jot(), new Error("fetch failed"));

	// It stays in the retry cycle…
	assert.deepEqual(updates, [
		["abcd1234", { status: "failed", attempts: 1, error: "fetch failed" }],
	]);
	assert.deepEqual(reactions, [["abcd1234", "retrying"]]);
	// …and the message says that instead of sitting on "Weaving it into your journal…".
	const msg = posted.at(-1);
	assert.equal(msg?.id, "abcd1234");
	assert.match(msg!.html, /didn't go through \(attempt 1 of \d+\)/);
	assert.match(msg!.html, /fetch failed/);
	assert.deepEqual(buttons(msg), { retry: true, discard: true });
});

test("giving up posts the same pair of buttons", async () => {
	const { processor, posted, reactions } = harness();
	await processor.fail(jot(), new Error("nonsense the model produced"));

	assert.deepEqual(reactions, [["abcd1234", "failed"]]);
	const msg = posted.at(-1);
	assert.match(msg!.html, /Gave up on a text jot \(unrecoverable error\)/);
	assert.deepEqual(buttons(msg), { retry: true, discard: true });
});

test("an out-of-tries jot gives up rather than promising another go", async () => {
	const { processor, posted } = harness();
	await processor.fail(
		jot({ attempts: MAX_ATTEMPTS - 1 }),
		new Error("timeout"),
	);
	const msg = posted.at(-1);
	assert.match(msg!.html, new RegExp(`no luck after ${MAX_ATTEMPTS} tries`));
	assert.deepEqual(buttons(msg), { retry: true, discard: true });
});

test("a squashed give-up still names the whole burst", async () => {
	const { processor, posted } = harness({
		followers: [jot({ id: "ffff0001", anchor: "abcd1234" })],
	});
	await processor.fail(jot(), new Error("bad input"));
	assert.match(posted.at(-1)!.html, /2 jots squashed into one entry/);
});

test("a failed status message that won't send doesn't take the batch down", async () => {
	const { processor } = harness();
	(processor as any).bot.status = async () => {
		throw new Error("telegram 502");
	};
	// fail() runs inside processJot's catch — a throw here would abandon the other jots.
	await processor.fail(jot(), new Error("fetch failed"));
});

// --- tasks spotted in a jot ---

const detected = [
	{ description: "Call the vet tomorrow", type: "personal" },
	{ description: "Answer the RFC", due: "next friday", type: "work" },
];

test("detected tasks become drafts dated from the jot's own day", async () => {
	const { processor } = harness();
	// The jot's note is 2026-08-16 (a Sunday), so "tomorrow" is the day after the entry —
	// not the day it happens to be processed.
	assert.deepEqual(await processor.tasksFrom(detected, jot()), [
		{
			description: "Call the vet",
			type: "personal",
			start: null,
			due: "2026-08-17",
		},
		{
			description: "Answer the RFC",
			type: "work",
			start: null,
			due: "2026-08-21",
		},
	]);
});

test("detection can be switched off, and never asks about the same jot twice", async () => {
	const off = harness({ detection: "off" });
	assert.deepEqual(await off.processor.tasksFrom(detected, jot()), []);

	// A jot that already produced drafts was asked about once — /reprocess must not ask
	// again about tasks that were created, or dismissed, weeks ago.
	const asked = harness({ priorDrafts: 2 });
	assert.deepEqual(await asked.processor.tasksFrom(detected, jot()), []);

	const none = harness();
	assert.deepEqual(await none.processor.tasksFrom([], jot()), []);
	assert.deepEqual(await none.processor.tasksFrom(undefined, jot()), []);
});
