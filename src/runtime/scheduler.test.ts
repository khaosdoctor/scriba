import assert from "node:assert/strict";
import { test } from "node:test";

// scheduler.ts pulls in config.ts, which validates process.env at import time — give it the
// bare minimum before loading, the same trick config.test.ts uses.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { Scheduler } = await import("./scheduler.ts");

const DAY = 24 * 60 * 60_000;

/** Hand back to the event loop so the awaits inside a fired timer can settle. Mock timers
 *  move the clock, not the microtask queue. */
const flush = async (times = 4) => {
	for (let i = 0; i < times; i++) await Promise.resolve();
};

type Stats = {
	total: number;
	audio: number;
	failed: number;
	abandoned: number;
};

function harness(stats: Partial<Stats> = {}, sweep?: () => Promise<void>) {
	const notified: string[] = [];
	const rated: string[] = [];
	const habits: string[] = [];
	let sweeps = 0;
	const repo = {
		windowStats: async (): Promise<Stats> => ({
			total: 0,
			audio: 0,
			failed: 0,
			abandoned: 0,
			...stats,
		}),
	};
	const processor = {
		retrySweep: async () => {
			sweeps++;
			if (sweep) await sweep();
		},
	};
	const scheduler = new Scheduler(
		repo as any,
		processor as any,
		async (text: string) => void notified.push(text),
		async (date: string) => void rated.push(date),
		async (date: string) => void habits.push(date),
		1000, // retry interval, in mock-clock ms
	);
	return {
		scheduler,
		notified,
		rated,
		habits,
		sweeps: () => sweeps,
	};
}

test("the retry sweep runs on its interval and stops when the scheduler does", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness();
	h.scheduler.start();

	// A tick at a time, letting each sweep settle: two firings inside one synchronous tick
	// would collapse into one, which is the overlap guard doing its job (see below).
	for (let i = 1; i <= 3; i++) {
		t.mock.timers.tick(1000);
		await flush();
		assert.equal(h.sweeps(), i);
	}

	h.scheduler.stop();
	t.mock.timers.tick(5000);
	await flush();
	assert.equal(h.sweeps(), 3);
});

test("a slow sweep doesn't stack up behind itself", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	const h = harness({}, () => held);
	h.scheduler.start();

	// Three ticks while the first sweep is still running: the guard should hold them off,
	// or a sweep slower than the interval would pile stacks on the same pending jots.
	t.mock.timers.tick(3000);
	await flush();
	assert.equal(h.sweeps(), 1);

	release();
	await flush();
	t.mock.timers.tick(1000);
	await flush();
	assert.equal(h.sweeps(), 2);
});

test("a sweep that throws is logged and the next one still runs", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	let boom = true;
	const h = harness({}, async () => {
		if (boom) throw new Error("obsidian is down");
	});
	h.scheduler.start();

	t.mock.timers.tick(1000);
	await flush();
	assert.equal(h.sweeps(), 1);
	// The guard is cleared in a finally — without it one failure stops sweeping forever.
	boom = false;
	t.mock.timers.tick(1000);
	await flush();
	assert.equal(h.sweeps(), 2);
});

test("the nightly prompts fire for the day that just ended, then re-arm", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness();
	h.scheduler.start();

	// Both prompts default to 00:00, so a full day's tick lands on them whatever "now" is.
	t.mock.timers.tick(DAY);
	await flush();
	assert.equal(h.rated.length, 1);
	assert.equal(h.habits.length, 1);
	assert.match(h.rated[0]!, /^\d{4}-\d{2}-\d{2}$/);

	// Re-armed for tomorrow rather than firing once and going quiet.
	t.mock.timers.tick(DAY);
	await flush();
	assert.equal(h.rated.length, 2);
	assert.equal(h.habits.length, 2);
});

test("a prompt that throws still re-arms for tomorrow", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	let calls = 0;
	const scheduler = new Scheduler(
		{ windowStats: async () => ({ total: 0 }) } as any,
		{ retrySweep: async () => {} } as any,
		async () => {},
		async () => {
			calls++;
			throw new Error("telegram is down");
		},
		async () => {},
		1000,
	);
	scheduler.start();

	t.mock.timers.tick(DAY);
	await flush();
	assert.equal(calls, 1);
	t.mock.timers.tick(DAY);
	await flush();
	assert.equal(calls, 2);
	scheduler.stop();
});

test("the daily summary stays quiet on a day with no jots", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness({ total: 0 });
	h.scheduler.start();
	t.mock.timers.tick(DAY);
	await flush();
	assert.deepEqual(h.notified, []);
});

test("the daily summary counts jots, and names failures only when there are some", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const clean = harness({ total: 4, audio: 1 });
	clean.scheduler.start();
	t.mock.timers.tick(DAY);
	await flush(8);
	assert.equal(clean.notified.length, 1);
	assert.match(clean.notified[0]!, /Jots: 4 \(voice: 1\)/);
	assert.ok(!clean.notified[0]!.includes("Failed"));
	clean.scheduler.stop();

	// failed and abandoned are one number to the reader: both mean "didn't land cleanly".
	const bad = harness({ total: 4, audio: 1, failed: 1, abandoned: 2 });
	bad.scheduler.start();
	t.mock.timers.tick(DAY);
	await flush(8);
	assert.match(bad.notified[0]!, /⚠️ Failed\/abandoned: 3/);
	bad.scheduler.stop();
});
