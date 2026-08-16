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

/** A session wired to stubs that record every Telegram call. */
async function harness() {
	const sent: { text: string; opts: any }[] = [];
	const edits: { chat: number; msg: number; text: string; opts: any }[] = [];
	let nextId = 100;
	const bot = {
		command: () => {},
		api: {
			sendMessage: async (_chat: number, text: string, opts: any = {}) => {
				sent.push({ text, opts });
				return { chat: { id: 7 }, message_id: nextId++ };
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
	);

	/** Every ctx.reply, with the id of the message it produced. */
	const replies: { text: string; id: number; opts: any }[] = [];
	const ctx = {
		reply: async (text: string, opts: any = {}) => {
			const id = nextId++;
			replies.push({ text, id, opts });
			return { chat: { id: 7 }, message_id: id };
		},
	};
	await session.start(ctx);
	replies.length = 0; // drop the "command mode is on" banner
	return { session, agent, ctx, replies, sent, edits };
}

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
	const { session, agent, ctx, replies } = await harness();
	await session.handle(ctx, "first");
	await settle();
	await session.handle(ctx, "second");
	await settle();

	assert.equal(replies.length, 2);
	assert.match(replies[0]!.text, /Working/);
	// The second one says it was seen and where it stands — the old code refused it.
	assert.match(replies[1]!.text, /Queued/);
	assert.match(replies[1]!.text, /1 message ahead/);
	// Only the first prompt is with the agent; the second waits its turn.
	assert.deepEqual(agent.prompts, ["first"]);
});

test("handle returns without waiting for the agent", async () => {
	const { session, agent, ctx } = await harness();
	// No result is ever emitted: if handle awaited the answer, this would hang.
	await session.handle(ctx, "first");
	await settle();
	assert.deepEqual(agent.prompts, ["first"]);
});

test("each answer lands on the message that asked for it", async () => {
	const { session, agent, ctx, replies, edits } = await harness();
	await session.handle(ctx, "first");
	await settle();
	await session.handle(ctx, "second");
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

test("reasoning and tool calls are relayed live, clipped to 330 characters", async () => {
	const { session, agent, ctx, sent } = await harness();
	await session.handle(ctx, "write a note");
	await settle();

	agent.emit(
		assistant(
			{ type: "thinking", thinking: `let me look first ${"x".repeat(600)}` },
			{
				type: "tool_use",
				name: "mcp__vault__vault_read",
				input: { path: "notes/a.md" },
			},
		),
	);
	await settle();

	const thought = sent.find((s) => s.text.startsWith("💭"));
	const call = sent.find((s) => s.text.startsWith("🔧"));
	assert.ok(thought, "the reasoning was relayed");
	assert.ok(thought!.text.length <= 330, "and clipped to 330 characters");
	assert.match(thought!.text, /let me look first/);
	assert.equal(call?.text, "🔧 vault_read · notes/a.md");
	// Live chatter shouldn't buzz the phone once per thought.
	assert.equal(thought!.opts.disable_notification, true);
});

test("prose written mid-run is relayed; the closing prose is the answer", async () => {
	const { session, agent, ctx, replies, sent, edits } = await harness();
	await session.handle(ctx, "go");
	await settle();

	agent.emit(assistant({ type: "text", text: "reading the folder first" }));
	agent.emit(
		assistant({
			type: "tool_use",
			name: "mcp__vault__vault_list",
			input: { dir: "notes" },
		}),
	);
	agent.emit(assistant({ type: "text", text: "wrote notes/a.md" }));
	agent.emit(result());
	await settle();

	assert.ok(sent.some((s) => s.text === "💬 reading the folder first"));
	// The last block is the reply, and it isn't duplicated into the live feed.
	assert.ok(!sent.some((s) => s.text.includes("wrote notes/a.md")));
	assert.ok(
		edits.some(
			(e) => e.msg === replies[0]!.id && e.text === "wrote notes/a.md",
		),
	);
});

test("a failing tool result is surfaced, a successful one is not", async () => {
	const { session, agent, ctx, sent } = await harness();
	await session.handle(ctx, "go");
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

	assert.deepEqual(
		sent.map((s) => s.text),
		["⚠️ no such note"],
	);
});

test("Stop interrupts the running turn and closes its message", async () => {
	const { session, agent, ctx, replies, edits } = await harness();
	await session.handle(ctx, "long one");
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
	const { session, agent, ctx, replies, edits } = await harness();
	await session.handle(ctx, "first");
	await settle();
	await session.handle(ctx, "second");
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
	const { session, agent, ctx, replies } = await harness();
	await session.handle(ctx, "go");
	await settle();
	agent.emit(result("done"));
	await settle();

	const [, , id] = stopData(replies[0]!).split(":");
	const t = tap();
	await session.handleTap(t.ctx, ["s", id]);
	assert.deepEqual(t.answered, ["nothing to stop"]);
});

test("a query that dies is rebuilt, and the queue keeps moving", async () => {
	const { session, agent, ctx, replies, edits } = await harness();
	await session.handle(ctx, "first");
	await settle();
	await session.handle(ctx, "second");
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
	const { session, agent, ctx, replies, edits } = await harness();
	await session.handle(ctx, "first");
	await settle();
	await session.handle(ctx, "second");
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
	const { session, agent, ctx } = await harness();
	await session.handle(ctx, "go");
	await settle();
	assert.ok(agent.options.maxThinkingTokens > 0);
});
