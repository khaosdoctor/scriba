import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../db.ts";
import { commands } from "./index.ts";
import type { Command, Deps } from "./types.ts";

/**
 * The admin commands are one file each but one surface: every entry in the registry is
 * looped over in `bot.ts` and handed the same `(ctx, args, deps)`. They're tested together
 * here for the same reason — what matters is the registry being well-formed and each
 * command's argument branching, not the files they happen to live in.
 */

const byName = (name: string): Command => {
	const cmd = commands.find((c) => c.name === name);
	assert.ok(cmd, `no /${name} in the registry`);
	return cmd;
};

const aJot = (over: Partial<Jot> = {}): Jot =>
	({
		id: "abcd1234",
		anchor: "abcd1234",
		kind: "text",
		status: "failed",
		attempts: 2,
		raw_text: "a thought",
		transcript: null,
		asset_path: null,
		note_path: "notes/daily notes/2026-08-16.md",
		time: "10:00:00",
		received_at: 0,
		error: "fetch failed",
		...over,
	}) as Jot;

/** Deps with every collaborator recorded. Anything a test doesn't override throws if
 *  touched, so a command reaching for something it shouldn't shows up as a failure. */
function deps(over: Record<string, any> = {}) {
	const calls: string[] = [];
	const track =
		(name: string, out?: any) =>
		async (...args: any[]) => {
			calls.push(`${name}(${args.join(",")})`);
			return typeof out === "function" ? out(...args) : out;
		};
	const d = {
		links: {},
		github: {},
		version: "1.34.0",
		sha: "abc1234",
		startedAt: Date.now(),
		...over,
		calls,
		// Spread per collaborator, after `over`: overriding one repo method must not drop
		// the rest of the tracked stubs with it.
		repo: {
			getJot: track("getJot", null),
			resetForRetry: track("resetForRetry"),
			resetFailed: track("resetFailed", 0),
			resetProcessing: track("resetProcessing", 0),
			failedJots: track("failedJots", []),
			stopwords: track("stopwords", new Set<string>()),
			addStopword: track("addStopword"),
			delStopword: track("delStopword", 0),
			rejectionList: track("rejectionList", []),
			setSetting: track("setSetting"),
			...over.repo,
		},
		queue: {
			add: (id: string) => void calls.push(`queue.add(${id})`),
			...over.queue,
		},
		processor: { retrySweep: track("retrySweep"), ...over.processor },
		transcriber: {
			mode: "local",
			setMode: (m: string) => void calls.push(`setMode(${m})`),
			...over.transcriber,
		},
	};
	return d as unknown as Deps & { calls: string[] };
}

/** A ctx that records replies, for the commands that answer with a keyboard themselves. */
function ctx() {
	const replies: { text: string; opts: any }[] = [];
	return {
		replies,
		ctx: {
			reply: async (text: string, opts: any = {}) => {
				replies.push({ text, opts });
			},
		} as any,
	};
}

test("the registry is well-formed and safe to hand to Telegram", () => {
	assert.ok(commands.length > 5);
	const names = commands.map((c) => c.name);
	assert.deepEqual(
		names.filter((n, i) => names.indexOf(n) !== i),
		[],
		"duplicate command names would register two handlers for one command",
	);
	for (const c of commands) {
		// setMyCommands rejects anything outside this shape, and bot.ts only warns on that
		// failure — one bad name silently costs the whole `/` menu.
		assert.match(c.name, /^[a-z0-9_]{1,32}$/, `bad command name: ${c.name}`);
		assert.ok(c.description.trim(), `/${c.name} has no description`);
		assert.ok(
			c.description.length <= 256,
			`/${c.name}'s description is too long`,
		);
		assert.equal(typeof c.run, "function");
	}
});

test("/help lists the whole registry, itself included", async () => {
	const out = await byName("help").run({} as any, "", deps());
	assert.ok(typeof out === "string");
	for (const c of commands)
		assert.ok(out.includes(`/${c.name} —`), `/help omits /${c.name}`);
	assert.ok(out.includes("/help —"));
});

test("/retry with an id resets and queues that jot alone", async () => {
	const d = deps({ repo: { getJot: async () => aJot() } });
	assert.equal(
		await byName("retry").run({} as any, " ABCD1234 ", d),
		"🔄 retrying abcd1234",
	);
	assert.ok(d.calls.includes("resetForRetry(abcd1234)"));
	assert.ok(d.calls.includes("queue.add(abcd1234)"));
	// One jot, so the sweep isn't kicked for the whole backlog.
	assert.ok(!d.calls.some((c) => c.startsWith("retrySweep")));
});

test("/retry with an unknown id says so instead of queueing nothing", async () => {
	const d = deps();
	assert.equal(await byName("retry").run({} as any, "nope", d), "no jot nope");
	assert.ok(!d.calls.some((c) => c.startsWith("resetForRetry")));
});

test("/retry with no args takes the failed ones; `all` includes the abandoned", async () => {
	// An override replaces the tracked stub, so it records its own argument: whether the
	// abandoned jots are swept back in is the whole difference between these two calls.
	const scope: boolean[] = [];
	const resetFailed = (n: number) => async (all: boolean) => {
		scope.push(all);
		return n;
	};

	const d = deps({ repo: { resetFailed: resetFailed(3) } });
	assert.equal(
		await byName("retry").run({} as any, "", d),
		"🔄 requeued 3 jots",
	);
	assert.ok(d.calls.some((c) => c.startsWith("retrySweep")));

	const all = deps({ repo: { resetFailed: resetFailed(1) } });
	assert.equal(
		await byName("retry").run({} as any, "ALL", all),
		"🔄 requeued 1 jot (incl. abandoned)",
	);
	assert.deepEqual(scope, [false, true]);
});

test("/retry doesn't run a sweep when nothing was requeued", async () => {
	const d = deps({ repo: { resetFailed: async () => 0 } });
	await byName("retry").run({} as any, "", d);
	assert.ok(!d.calls.some((c) => c.startsWith("retrySweep")));
});

test("/stopword add and del need a word, and say what changed", async () => {
	const add = deps();
	assert.equal(
		await byName("stopword").run({} as any, "add Monday", add),
		'➕ stopword "monday"',
	);
	assert.ok(add.calls.includes("addStopword(Monday)"));
	assert.equal(
		await byName("stopword").run({} as any, "add", deps()),
		"usage: /stopword add <word>",
	);

	const hit = deps({ repo: { delStopword: async () => 1 } });
	assert.equal(
		await byName("stopword").run({} as any, "del Monday", hit),
		'➖ removed "monday"',
	);
	// Nothing removed is not the same as removed — the reply has to tell them apart.
	assert.equal(
		await byName("stopword").run({} as any, "del Monday", deps()),
		'no stopword "monday"',
	);
});

test("/stopword list paginates, and a bad subcommand gets usage", async () => {
	const words = new Set(Array.from({ length: 130 }, (_, i) => `w${i + 1000}`));
	const d = deps({ repo: { stopwords: async () => words } });
	const page1 = (await byName("stopword").run({} as any, "list", d)) as string;
	assert.match(page1, /page 1\/3/);
	assert.match(page1, /next: \/stopword list 2/);
	const page2 = (await byName("stopword").run(
		{} as any,
		"list 2",
		d,
	)) as string;
	assert.match(page2, /page 2\/3/);
	// Out-of-range and junk page numbers clamp rather than answering with a blank page.
	assert.match(
		(await byName("stopword").run({} as any, "list 99", d)) as string,
		/page 3\/3/,
	);
	assert.match(
		(await byName("stopword").run({} as any, "list zz", d)) as string,
		/page 1\/3/,
	);
	assert.equal(
		await byName("stopword").run({} as any, "", deps()),
		"usage: /stopword add|del|list [word]",
	);
	assert.equal(
		await byName("stopword").run({} as any, "list", deps()),
		"(none)",
	);
});

test("/transcriber shows the mode, sets a valid one, and refuses the rest", async () => {
	assert.equal(
		await byName("transcriber").run({} as any, "", deps()),
		"transcriber: local",
	);
	assert.equal(
		await byName("transcriber").run({} as any, "sideways", deps()),
		"usage: /transcriber [local|remote]",
	);

	const ok = deps();
	assert.equal(
		await byName("transcriber").run({} as any, " REMOTE ", ok),
		"🎙 transcriber → remote",
	);
	assert.ok(ok.calls.includes("setMode(remote)"));
	// Persisted, or the mode silently reverts on the next restart.
	assert.ok(ok.calls.includes("setSetting(transcriber,remote)"));
});

test("/transcriber leaves the setting alone when the switch refuses", async () => {
	const d = deps({
		transcriber: {
			mode: "local",
			setMode: () => {
				throw new Error("GROQ_API_KEY is not set");
			},
		},
	});
	assert.equal(
		await byName("transcriber").run({} as any, "remote", d),
		"⚠️ GROQ_API_KEY is not set",
	);
	assert.ok(!d.calls.some((c) => c.startsWith("setSetting")));
});

test("/jot needs an id and reports one that isn't there", async () => {
	assert.equal(
		await byName("jot").run({} as any, "  ", deps()),
		"usage: /jot <id>",
	);
	assert.equal(
		await byName("jot").run({} as any, "abcd1234", deps()),
		"no jot abcd1234",
	);
	const found = (await byName("jot").run(
		{} as any,
		"abcd1234",
		deps({ repo: { getJot: async () => aJot() } }),
	)) as string;
	assert.match(found, /abcd1234/);
});

test("/failed lists nothing cheerfully, and otherwise gives a button per jot", async () => {
	const empty = ctx();
	assert.equal(
		await byName("failed").run(empty.ctx, "", deps()),
		"✅ nothing failed.",
	);
	assert.equal(empty.replies.length, 0);

	const jots = [aJot(), aJot({ id: "ffff0001", status: "abandoned" })];
	const some = ctx();
	await byName("failed").run(
		some.ctx,
		"",
		deps({ repo: { failedJots: async () => jots } }),
	);
	const [reply] = some.replies;
	assert.match(reply!.text, /2 failed/);
	assert.match(reply!.text, /abcd1234 \[text\] failed ×2 — fetch failed/);
	// grammy leaves a trailing empty row after the last .row(); count the filled ones.
	const rows = reply!.opts.reply_markup.inline_keyboard.filter(
		(r: any[]) => r.length,
	);
	assert.equal(rows.length, 2, "one row per jot");
	// The same 🔄 Retry / 🗑 Delete pair the failure messages carry, per row.
	assert.deepEqual(
		rows.map((r: any[]) => r.map((b: any) => b.callback_data)),
		[
			["rt:abcd1234", "dl:abcd1234"],
			["rt:ffff0001", "dl:ffff0001"],
		],
	);
});

test("/rejections and /unstick report their counts", async () => {
	assert.equal(
		await byName("rejections").run({} as any, "", deps()),
		"(no rejections)",
	);
	const listed = (await byName("rejections").run(
		{} as any,
		"",
		deps({
			repo: {
				rejectionList: async () => [{ surface: "monday", note: "Monday" }],
			},
		}),
	)) as string;
	assert.equal(listed, '"monday" ✗ [[Monday]]');

	assert.equal(
		await byName("unstick").run({} as any, "", deps()),
		"🔧 unstuck 0 jots",
	);
	assert.equal(
		await byName("unstick").run(
			{} as any,
			"",
			deps({ repo: { resetProcessing: async () => 1 } }),
		),
		"🔧 unstuck 1 jot",
	);
});
