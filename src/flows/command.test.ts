import assert from "node:assert/strict";
import { test } from "node:test";

// command.ts pulls in config.ts, which validates process.env at import time — give it the
// bare minimum before loading, the same trick config.test.ts uses.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { CommandSession } = await import("./command.ts");

/** Let the session's promise chains (agent stream, serialized Telegram sends) run out. */
const settle = async (times = 6) => {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 1));
};

/**
 * A stand-in for the agent SDK's `query`: records the prompts pushed into its streaming
 * input and lets a test emit stream messages back whenever it likes, so the interleaving
 * a real agent produces can be reproduced exactly.
 */
class FakeAgent {
	prompts: string[] = [];
	interrupts = 0;
	options: any;
	private out: any[] = [];
	private wake: (() => void) | null = null;
	private ended = false;

	query = (params: any) => {
		this.options = params.options;
		void this.drain(params.prompt);
		const self = this;
		const gen = (async function* () {
			for (;;) {
				while (self.out.length) yield self.out.shift();
				if (self.ended) return;
				await new Promise<void>((r) => {
					self.wake = r;
				});
			}
		})();
		(gen as any).interrupt = async () => {
			self.interrupts++;
		};
		return gen as any;
	};

	private async drain(stream: AsyncIterable<any>): Promise<void> {
		// The same shape the CLI is handed: {role, content: [{type:"text", text}]}.
		for await (const m of stream) this.prompts.push(m.message.content[0].text);
	}

	emit(msg: any): void {
		this.out.push(msg);
		this.wake?.();
		this.wake = null;
	}
	/** End the query's output stream, as an SDK crash or a torn-down CLI would. */
	end(): void {
		this.ended = true;
		this.wake?.();
		this.wake = null;
	}
}

const assistant = (...content: any[]) => ({
	type: "assistant",
	message: { content },
});
const result = (text?: string, subtype = "success") => ({
	type: "result",
	subtype,
	session_id: "s1",
	...(text === undefined ? {} : { result: text }),
});

/** The chat the owner talks to the bot in. Deliberately not the configured user id, so a
 *  message addressed to the wrong one shows up as a failure. */
const CHAT = 7;

/** A session wired to stubs that record every Telegram call. */
async function harness(feedEditMs = 0) {
	const sent: { chat: number; text: string; opts: any }[] = [];
	const edits: { chat: number; msg: number; text: string; opts: any }[] = [];
	let nextId = 100;
	const bot = {
		command: () => {},
		api: {
			sendMessage: async (chat: number, text: string, opts: any = {}) => {
				sent.push({ chat, text, opts });
				return { chat: { id: chat }, message_id: nextId++ };
			},
			editMessageText: async (
				chat: number,
				msg: number,
				text: string,
				opts: any = {},
			) => {
				edits.push({ chat, msg, text, opts });
				return true;
			},
		},
	};
	const vault = {
		enabled: true,
		fetchPage: async () => "# AI Writing Tropes to Avoid\nnope",
	};
	const agent = new FakeAgent();
	const session: any = new CommandSession(
		bot as any,
		vault as any,
		agent.query as any,
		feedEditMs,
	);

	/** Every ctx.reply, with the id of the message it produced and the one it answers. */
	const replies: { text: string; id: number; source: number; opts: any }[] = [];
	const reply =
		(source: number) =>
		async (text: string, opts: any = {}) => {
			const id = nextId++;
			replies.push({ text, id, source, opts });
			return { chat: { id: CHAT }, message_id: id };
		};
	const ctx = { chat: { id: CHAT }, reply: reply(0) };

	/** Deliver a message the way Telegram does: its own incoming message id, which is what
	 *  everything about that turn should hang off. Returns that id. */
	const say = async (text: string): Promise<number> => {
		const incoming = nextId++;
		await session.handle(
			{
				chat: { id: CHAT },
				message: { message_id: incoming, text },
				reply: reply(incoming),
			},
			text,
		);
		return incoming;
	};

	await session.start(ctx);
	replies.length = 0; // drop the "command mode is on" banner
	return { session, agent, ctx, say, replies, sent, edits };
}

/** The text of every edit made to one message, oldest first. */
const editsTo = (edits: { msg: number; text: string }[], id: number) =>
	edits.filter((e) => e.msg === id).map((e) => e.text);

/** What a recorded send/reply is threaded under, if anything. */
const repliedTo = (call: { opts: any }) =>
	call.opts?.reply_parameters?.message_id;

/** The callback data behind a status message's ⏹ Stop button. */
const stopData = (reply: { opts: any }) =>
	reply.opts.reply_markup.inline_keyboard[0][0].callback_data as string;

const tap = () => {
	const answered: string[] = [];
	return {
		answered,
		ctx: {
			answerCallbackQuery: async (o: any) => void answered.push(o.text),
			editMessageText: async () => {},
			callbackQuery: { message: { text: "" } },
		} as any,
	};
};

test("a message sent while the agent is working is accepted, not refused", async () => {
	const { agent, say, replies } = await harness();
	const m1 = await say("first");
	await settle();
	const m2 = await say("second");
	await settle();

	assert.equal(replies.length, 2);
	assert.match(replies[0]!.text, /Working/);
	// The second one says it was seen and where it stands — the old code refused it.
	assert.match(replies[1]!.text, /Queued/);
	assert.match(replies[1]!.text, /1 message ahead/);
	// Each status message hangs off the message that asked for it.
	assert.equal(repliedTo(replies[0]!), m1);
	assert.equal(repliedTo(replies[1]!), m2);
	// Only the first prompt is with the agent; the second waits its turn.
	assert.deepEqual(agent.prompts, ["first"]);
});

test("handle returns without waiting for the agent", async () => {
	const { agent, say } = await harness();
	// No result is ever emitted: if handle awaited the answer, this would hang.
	await say("first");
	await settle();
	assert.deepEqual(agent.prompts, ["first"]);
});

test("each answer lands on the message that asked for it", async () => {
	const { agent, say, replies, edits } = await harness();
	await say("first");
	await settle();
	await say("second");
	await settle();

	agent.emit(assistant({ type: "text", text: "one done" }));
	agent.emit(result());
	await settle();

	const firstId = replies[0]!.id;
	const secondId = replies[1]!.id;
	// The first prompt's status message became its answer, and lost its button.
	const answer = edits.find((e) => e.msg === firstId && e.text === "one done");
	assert.ok(answer, "the first prompt's message was edited into the answer");
	assert.deepEqual(answer!.opts.reply_markup.inline_keyboard.flat(), []);
	// The second was handed over and its message promoted out of the queue.
	assert.deepEqual(agent.prompts, ["first", "second"]);
	assert.ok(edits.some((e) => e.msg === secondId && /Working/.test(e.text)));

	agent.emit(assistant({ type: "text", text: "two done" }));
	agent.emit(result());
	await settle();
	assert.ok(edits.some((e) => e.msg === secondId && e.text === "two done"));
});

test("the live feed rewrites one message instead of posting more", async () => {
	const { agent, say, replies, sent, edits } = await harness();
	const m1 = await say("write a note");
	await settle();

	agent.emit(
		assistant(
			{ type: "thinking", thinking: `let me read the note ${"x".repeat(600)}` },
			{
				type: "tool_use",
				name: "mcp__vault__vault_read",
				input: { path: "notes/a.md" },
			},
		),
	);
	await settle();

	// Not one message per thought — that's what buried the chat.
	assert.deepEqual(sent, []);
	const status = replies[0]!;
	assert.equal(repliedTo(status), m1);
	const latest = editsTo(edits, status.id).at(-1)!;
	// The header stays, and the feed accumulates under it in order.
	assert.match(latest, /^🧭 Working…\n\n/);
	assert.match(latest, /let me read the note/);
	assert.match(latest, /📖 vault_read · notes\/a\.md$/);
	// Each line is still capped, so one long thought can't fill the message.
	for (const line of latest.split("\n").slice(2))
		assert.ok(line.length <= 330, `feed line too long: ${line.length}`);
});

test("each line carries an emoji for what it is", async () => {
	const { agent, say, replies, edits } = await harness();
	await say("go");
	await settle();

	agent.emit(
		assistant(
			{ type: "thinking", thinking: "let me search for the meeting note" },
			{ type: "tool_use", name: "mcp__vault__vault_search", input: {} },
			{
				type: "tool_use",
				name: "mcp__vault__vault_write",
				input: { path: "a.md" },
			},
			{ type: "tool_use", name: "WebSearch", input: {} },
			{ type: "tool_use", name: "mcp__vault__mystery_tool", input: {} },
		),
	);
	await settle();

	const lines = editsTo(edits, replies[0]!.id).at(-1)!.split("\n").slice(2);
	assert.deepEqual(
		lines.map((l) => l.split(" ")[0]),
		["🔍", "🔍", "✍️", "🔎", "🔧"],
	);
});

test("the feed drops its oldest lines rather than outgrow the message", async () => {
	const { agent, say, replies, edits } = await harness();
	await say("go");
	await settle();

	// Each thought clips to 330 characters, so ~13 of them pass Telegram's 4096 cap.
	for (let i = 0; i < 30; i++) {
		agent.emit(
			assistant({ type: "thinking", thinking: `step ${i} ${"x".repeat(400)}` }),
		);
		await settle(2);
	}

	const latest = editsTo(edits, replies[0]!.id).at(-1)!;
	assert.ok(latest.length <= 4096, `message is ${latest.length} characters`);
	// The newest line survives; the oldest ones are the ones that went.
	assert.match(latest, /step 29/);
	assert.ok(!latest.includes("step 0 "));
});

test("feed edits are throttled, so a busy agent doesn't hammer Telegram", async () => {
	// A gap far longer than the test: whatever lands after the first edit waits for it.
	const { agent, say, replies, edits } = await harness(10_000);
	await say("go");
	await settle();
	const before = editsTo(edits, replies[0]!.id).length;

	for (const t of ["one", "two", "three"]) {
		agent.emit(assistant({ type: "thinking", thinking: t }));
		await settle();
	}
	assert.equal(
		editsTo(edits, replies[0]!.id).length - before,
		1,
		"three updates in quick succession should coalesce into one edit",
	);
});

test("prose written mid-run joins the feed; the closing prose is the answer", async () => {
	const { agent, say, replies, edits } = await harness();
	await say("go");
	await settle();

	// Spaced out, the way a real run arrives: prose, then the tool call that supersedes it.
	// (A turn that finishes before the next render just skips that frame — the answer wins.)
	agent.emit(assistant({ type: "text", text: "reading the folder first" }));
	await settle();
	agent.emit(
		assistant({
			type: "tool_use",
			name: "mcp__vault__vault_list",
			input: { dir: "notes" },
		}),
	);
	await settle();
	agent.emit(assistant({ type: "text", text: "wrote notes/a.md" }));
	agent.emit(result());
	await settle();

	const seen = editsTo(edits, replies[0]!.id);
	assert.ok(seen.some((t) => t.includes("reading the folder first")));
	// The last block is the answer: the message ends as that alone, feed cleared away.
	assert.equal(seen.at(-1), "wrote notes/a.md");
});

test("the feed follows whichever prompt is being answered", async () => {
	const { agent, say, replies, edits } = await harness();
	await say("first");
	await settle();
	await say("second");
	await settle();

	agent.emit(assistant({ type: "thinking", thinking: "on the first" }));
	await settle();
	agent.emit(result("first answered"));
	await settle();
	// The queue has moved on: the next turn's chatter belongs to the next message.
	agent.emit(assistant({ type: "thinking", thinking: "on the second" }));
	await settle();

	const one = editsTo(edits, replies[0]!.id);
	const two = editsTo(edits, replies[1]!.id);
	assert.ok(one.some((t) => t.includes("on the first")));
	assert.equal(
		one.at(-1),
		"first answered",
		"the answer is the last word on it",
	);
	assert.ok(two.some((t) => t.includes("on the second")));
	assert.ok(!two.some((t) => t.includes("on the first")));
});

test("a failing tool result is surfaced, a successful one is not", async () => {
	const { agent, say, replies, edits } = await harness();
	await say("go");
	await settle();

	agent.emit({
		type: "user",
		message: {
			content: [
				{ type: "tool_result", is_error: true, content: "no such note" },
				{ type: "tool_result", content: "# fine" },
			],
		},
	});
	await settle();

	const lines = editsTo(edits, replies[0]!.id).at(-1)!.split("\n").slice(2);
	assert.deepEqual(lines, ["⚠️ no such note"]);
});

test("a deleted prompt can't take its answer down with it", async () => {
	const { say, replies } = await harness();
	await say("go");
	await settle();
	// Telegram refuses a reply to a message that's gone unless this is set.
	assert.equal(
		replies[0]!.opts.reply_parameters.allow_sending_without_reply,
		true,
	);
});

test("Stop interrupts the running turn and closes its message", async () => {
	const { session, agent, say, replies, edits } = await harness();
	await say("long one");
	await settle();

	const [, , id] = stopData(replies[0]!).split(":");
	const t = tap();
	await session.handleTap(t.ctx, ["s", id]);
	await settle();
	assert.equal(agent.interrupts, 1);
	assert.deepEqual(t.answered, ["stopping…"]);

	// The interrupt comes back as a result; the turn settles as stopped, not as an answer.
	agent.emit(result(undefined, "error_during_execution"));
	await settle();
	const last = edits.filter((e) => e.msg === replies[0]!.id).at(-1);
	assert.match(last!.text, /Stopped/);
});

test("Stop on a queued prompt drops it without touching the agent", async () => {
	const { session, agent, say, replies, edits } = await harness();
	await say("first");
	await settle();
	await say("second");
	await settle();

	const [, , id] = stopData(replies[1]!).split(":");
	const t = tap();
	await session.handleTap(t.ctx, ["s", id]);
	await settle();

	assert.equal(agent.interrupts, 0);
	assert.deepEqual(t.answered, ["dropped"]);
	assert.match(
		edits.filter((e) => e.msg === replies[1]!.id).at(-1)!.text,
		/Dropped/,
	);
	// And it never reaches the agent, even after the running turn finishes.
	agent.emit(result("done"));
	await settle();
	assert.deepEqual(agent.prompts, ["first"]);
});

test("a stop for a turn that already finished says so", async () => {
	const { session, agent, say, replies } = await harness();
	await say("go");
	await settle();
	agent.emit(result("done"));
	await settle();

	const [, , id] = stopData(replies[0]!).split(":");
	const t = tap();
	await session.handleTap(t.ctx, ["s", id]);
	assert.deepEqual(t.answered, ["nothing to stop"]);
});

test("a query that dies is rebuilt, and the queue keeps moving", async () => {
	const { agent, say, replies, edits } = await harness();
	await say("first");
	await settle();
	await say("second");
	await settle();

	agent.end(); // the CLI exits mid-turn
	await settle();

	// The turn it was on says so rather than spinning forever…
	assert.match(
		edits.filter((e) => e.msg === replies[0]!.id).at(-1)!.text,
		/stopped early/,
	);
	// …and the waiting prompt goes to a fresh query, resuming the same conversation.
	assert.deepEqual(agent.prompts, ["first", "second"]);
});

test("closing the session answers everything still in flight", async () => {
	const { session, agent, ctx, say, replies, edits } = await harness();
	await say("first");
	await settle();
	await say("second");
	await settle();

	const inFlight = [...replies]; // finish() posts its own reply; only these two matter
	await session.finish(ctx);
	await settle();

	assert.equal(session.isOpen(), false);
	assert.equal(agent.interrupts, 1);
	for (const r of inFlight)
		assert.match(
			edits.filter((e) => e.msg === r.id).at(-1)!.text,
			/Command mode closed/,
		);
});

test("the agent is given a thinking budget, so there is reasoning to relay", async () => {
	const { agent, say } = await harness();
	await say("go");
	await settle();
	assert.ok(agent.options.maxThinkingTokens > 0);
});
