import assert from "node:assert/strict";
import { test } from "node:test";

// index.ts pulls in config.ts, which validates process.env at import time — give it the
// bare minimum before loading, the same trick config.test.ts and menu.test.ts use.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { TasksFlow, parseTaskPromptRef, taskDetectionEnabled } = await import(
	"./index.ts"
);
const { TaskStore } = await import("../../services/tasks.ts");

type Sent = { chat: number; text: string; markup?: any; silent?: unknown };
type Edited = { chat: number; msg: number; text: string; markup?: any };

/** A bot stub that records what reached Telegram, a task store over an in-memory note, and
 *  an in-memory stand-in for the draft table — enough to drive the whole flow. */
function harness(
	note = [
		"---",
		"updatedAt: 2026-08-01T10:00:00Z",
		"---",
		"## Things to do",
		"- [ ] Buy cat sand #type/todo [start:: 2026-08-28] [due:: 2026-09-02]",
		"- [x] finish the book #type/todo [due:: 2026-06-14] [completion:: 2026-06-23]",
	].join("\n"),
) {
	const sent: Sent[] = [];
	const edited: Edited[] = [];
	const answered: string[] = [];
	const deleted: [number, number][] = [];
	let nextId = 100;
	const bot = {
		api: {
			sendMessage: async (chat: number, text: string, opts?: any) => {
				sent.push({
					chat,
					text,
					markup: opts?.reply_markup,
					silent: opts?.disable_notification ?? null,
				});
				return { message_id: nextId++, chat: { id: chat } };
			},
			editMessageText: async (
				chat: number,
				msg: number,
				text: string,
				opts?: any,
			) => {
				edited.push({ chat, msg, text, markup: opts?.reply_markup });
			},
			deleteMessage: async (chat: number, msg: number) => {
				deleted.push([chat, msg]);
			},
		},
		command: () => {},
	};

	const drafts = new Map<string, any>();
	const settings = new Map<string, string>();
	const repo = {
		insertTaskDraft: async (d: any) => void drafts.set(d.id, { ...d }),
		getTaskDraft: async (id: string) => drafts.get(id),
		updateTaskDraft: async (id: string, patch: any) =>
			void drafts.set(id, { ...drafts.get(id), ...patch }),
		claimTaskDraft: async (id: string) => {
			const d = drafts.get(id);
			if (d?.status !== "pending") return false;
			drafts.set(id, { ...d, status: "created" });
			return true;
		},
		getSetting: async (k: string) => settings.get(k),
		setSetting: async (k: string, v: string) => void settings.set(k, v),
	};

	// A minimal Obsidian stand-in: one note in memory, read and written whole.
	const vault = { content: note };
	let broken = false;
	const obsidian = {
		readNote: async () => {
			if (broken) throw new Error("obsidian is down");
			return vault.content;
		},
		writeNote: async (_p: string, c: string) => {
			vault.content = c;
		},
		withNoteLock: async <T>(_p: string, fn: () => Promise<T>) => fn(),
	};
	const store = new TaskStore(obsidian as any, {
		work: {
			path: "work.md",
			heading: "Other Tasks",
			tag: "#type/todo/work",
			insert: "top",
		},
		personal: {
			path: "personal.md",
			heading: "Things to do",
			tag: "#type/todo",
			insert: "bottom",
		},
	});
	// The enricher is the one collaborator that spends a token; the harness makes its
	// answer (and its failure) something a test can choose.
	let extract: (text: string) => Promise<any> = async (text) => ({
		description: text,
		type: "personal",
	});
	const enricher = { extractTask: (t: string) => extract(t) };
	const flow = new TasksFlow(
		bot as any,
		repo as any,
		store,
		enricher as any,
		() => false,
	);

	const ctx = {
		chat: { id: 7 },
		reply: async (text: string, opts?: any) => {
			sent.push({ chat: 7, text, markup: opts?.reply_markup });
			return { message_id: nextId++, chat: { id: 7 } };
		},
		answerCallbackQuery: async (o?: any) => void answered.push(o?.text ?? ""),
		deleteMessage: async () => {
			deleted.push([7, 1]);
		},
		editMessageText: async (text: string, opts?: any) => {
			edited.push({ chat: 7, msg: 1, text, markup: opts?.reply_markup });
		},
	};
	const buttons = (m?: any): string[] =>
		(m?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data);
	return {
		flow,
		sent,
		edited,
		answered,
		deleted,
		drafts,
		vault,
		ctx,
		buttons,
		settings,
		breakReads: (v: boolean) => {
			broken = v;
		},
		setExtract: (fn: (text: string) => Promise<any>) => {
			extract = fn;
		},
	};
}

const draftId = (drafts: Map<string, any>) => [...drafts.keys()][0]!;

test("a message in task mode becomes a draft on a card, not a task in the note", async () => {
	const h = harness();
	const before = h.vault.content;
	await h.flow.handle(h.ctx as any, "buy cat sand next week");
	assert.equal(h.drafts.size, 1);
	const d = h.drafts.get(draftId(h.drafts));
	assert.equal(d.description, "buy cat sand");
	assert.equal(d.status, "pending");
	assert.equal(d.type, "personal");
	assert.equal(h.vault.content, before); // nothing written until ✅
	const card = h.sent.at(-1)!;
	assert.match(card.text, /📝 New task/);
	assert.match(card.text, /buy cat sand/);
	assert.deepEqual(h.buttons(card.markup), [
		`tk:d:${d.id}`,
		`tk:t:${d.id}`,
		`tk:s:${d.id}`,
		`tk:u:${d.id}`,
		`tk:ok:${d.id}`,
		`tk:x:${d.id}`,
	]);
});

test("a message with nothing to do is refused instead of drafted", async () => {
	const h = harness();
	await h.flow.handle(h.ctx as any, "next week");
	assert.equal(h.drafts.size, 0);
	assert.match(h.sent.at(-1)!.text, /couldn't find anything to do/);
});

test("the type button toggles, and ✅ writes the task into its note", async () => {
	const h = harness();
	await h.flow.handle(h.ctx as any, "review the RFC by next friday");
	const id = draftId(h.drafts);
	await h.flow.handleTap(h.ctx as any, ["t", id]);
	assert.equal(h.drafts.get(id).type, "work");
	await h.flow.handleTap(h.ctx as any, ["t", id]);
	assert.equal(h.drafts.get(id).type, "personal");

	await h.flow.handleTap(h.ctx as any, ["ok", id]);
	assert.equal(h.drafts.get(id).status, "created");
	assert.match(
		h.vault.content,
		/- \[ \] review the RFC \(from \[\[\d{4}-\d{2}-\d{2}\]\]\) #type\/todo/,
	);
	assert.match(h.edited.at(-1)!.text, /✅ Added to 🏠 Personal/);
	assert.deepEqual(h.buttons(h.edited.at(-1)!.markup), []); // no buttons left
});

test("✅ refuses a task with no deadline and asks for one", async () => {
	const h = harness();
	await h.flow.handle(h.ctx as any, "buy milk");
	const id = draftId(h.drafts);
	await h.flow.handleTap(h.ctx as any, ["ok", id]);
	assert.equal(h.drafts.get(id).status, "pending");
	assert.match(h.answered.at(-1)!, /needs a due date/);
	assert.match(h.sent.at(-1)!.text, /with the due date.*\(tk:u:/s);
	// Straight off the ✅ button, so the compose box is pointed at it: you just tapped, you
	// can't have been mid-message.
	assert.equal(h.sent.at(-1)!.markup.force_reply, true);
});

test("a reply to a date prompt is read, and a bad one is refused", async () => {
	const h = harness();
	await h.flow.handle(h.ctx as any, "buy milk");
	const id = draftId(h.drafts);
	const prompt = `🏁 When is it due? (tk:u:${id})`;
	assert.deepEqual(parseTaskPromptRef(prompt), { field: "u", id });
	assert.equal(h.flow.isTaskPrompt(prompt), true);
	assert.equal(h.flow.isTaskPrompt("just a message"), false);

	const reply = (text: string) =>
		({
			...h.ctx,
			message: { text, reply_to_message: { message_id: 99 } },
		}) as any;

	await h.flow.handleReply(reply("2026-09-15"), prompt);
	assert.equal(h.drafts.get(id).due, "2026-09-15");

	await h.flow.handleReply(reply("banana"), prompt);
	assert.equal(h.drafts.get(id).due, "2026-09-15"); // unchanged
	assert.match(h.sent.at(-1)!.text, /couldn't read that as a date/);

	// The deadline is the mandatory one, so it can't be cleared.
	await h.flow.handleReply(reply("none"), prompt);
	assert.equal(h.drafts.get(id).due, "2026-09-15");
	assert.match(h.sent.at(-1)!.text, /needs a deadline/);
});

test("an answered prompt is taken back out of the chat, an unanswerable one stays", async () => {
	const h = harness();
	await h.flow.handle(h.ctx as any, "buy milk");
	const id = draftId(h.drafts);
	// ✅ with no deadline asks for one; that question is the message being replied to.
	await h.flow.handleTap(h.ctx as any, ["ok", id]);
	const asked = h.sent.at(-1)!;
	assert.match(asked.text, /with the due date/);
	const promptId = 100; // the harness numbers its messages from 100
	const reply = (text: string) =>
		({
			...h.ctx,
			message: { text, reply_to_message: { message_id: promptId } },
		}) as any;

	// A date it can't read leaves the question standing — there'd be nothing to reply to.
	await h.flow.handleReply(reply("banana"), asked.text);
	assert.deepEqual(h.deleted, []);

	// A date it can read answers the question, so the question goes.
	await h.flow.handleReply(reply("next friday"), asked.text);
	assert.deepEqual(h.deleted, [[7, promptId]]);
});

test("settling a card clears the questions still hanging off it", async () => {
	const h = harness();
	await h.flow.suggest(
		{ description: "Call the vet", type: "personal", start: null, due: null },
		"jot12345",
		"2026-08-20",
	);
	const id = draftId(h.drafts);
	// The suggestion asked for a deadline; dropping the card takes the question with it.
	assert.match(h.sent.at(-1)!.text, /with the due date/);
	await h.flow.handleTap(h.ctx as any, ["x", id]);
	assert.equal(h.deleted.length, 1);
	assert.equal(h.drafts.get(id).status, "dismissed");
});

test("a suggestion from a jot carries the jot's day and asks for a missing deadline", async () => {
	const h = harness();
	await h.flow.suggest(
		{ description: "Call the vet", type: "personal", start: null, due: null },
		"jot12345",
		"2026-08-20",
	);
	const d = h.drafts.get(draftId(h.drafts));
	assert.equal(d.source, "jot");
	assert.equal(d.jot_id, "jot12345");
	assert.equal(d.source_date, "2026-08-20");
	assert.match(h.sent[0]!.text, /That sounds like a task/);
	// Its cancel button dismisses rather than drops, and the deadline is asked for outright.
	assert.equal(
		h.sent[0]!.markup.inline_keyboard.flat().at(-1).text,
		"🚫 Not a task",
	);
	assert.match(h.sent[1]!.text, /with the due date/);

	await h.flow.handleTap(h.ctx as any, ["x", d.id]);
	assert.equal(h.drafts.get(d.id).status, "dismissed");
	assert.match(h.edited.at(-1)!.text, /Not a task/);
});

test("two fast taps on ✅ write the task once", async () => {
	const h = harness();
	await h.flow.handle(h.ctx as any, "buy cat sand next week");
	const id = draftId(h.drafts);
	await Promise.all([
		h.flow.handleTap(h.ctx as any, ["ok", id]),
		h.flow.handleTap(h.ctx as any, ["ok", id]),
	]);
	const lines = h.vault.content
		.split("\n")
		.filter((l) => l.includes("buy cat sand"));
	assert.equal(lines.length, 1);
	assert.match(h.answered.join(" "), /already created/);
});

test("a settled draft ignores later taps", async () => {
	const h = harness();
	await h.flow.handle(h.ctx as any, "buy cat sand next week");
	const id = draftId(h.drafts);
	await h.flow.handleTap(h.ctx as any, ["x", id]);
	assert.equal(h.drafts.get(id).status, "cancelled");
	await h.flow.handleTap(h.ctx as any, ["ok", id]);
	assert.match(h.answered.at(-1)!, /already cancelled/);
	await h.flow.handleTap(h.ctx as any, ["ok", "nosuchid"]);
	assert.match(h.answered.at(-1)!, /expired/);
});

test("a list ticks the task it points at and redraws itself", async () => {
	const h = harness();
	await h.flow.handleTap(h.ctx as any, ["v", "open", "0"]);
	const list = h.edited.at(-1)!;
	assert.match(list.text, /📋 All open tasks/);
	assert.match(list.text, /1\. ☐ Buy cat sand · due 2026-09-02/);
	const [tick] = h.buttons(list.markup);
	assert.match(tick!, /^tk:k:personal:0:[0-9a-f]{8}:open:0$/);

	await h.flow.handleTap(h.ctx as any, tick!.split(":").slice(1));
	assert.match(
		h.vault.content,
		/- \[x\] Buy cat sand .*\[completion:: \d{4}-\d{2}-\d{2}\]/,
	);
	assert.match(h.edited.at(-1)!.text, /Nothing here\./); // redrawn: no open tasks left
});

test("a tick whose note moved underneath is refused and the list redrawn", async () => {
	const h = harness();
	await h.flow.handleTap(h.ctx as any, ["v", "open", "0"]);
	const [tick] = h.buttons(h.edited.at(-1)!.markup);
	h.vault.content = h.vault.content.replace(
		"Buy cat sand",
		"Buy something else",
	);
	await h.flow.handleTap(h.ctx as any, tick!.split(":").slice(1));
	assert.match(h.vault.content, /- \[ \] Buy something else/); // not ticked
	assert.match(h.sent.at(-1)!.text, /moved or changed in Obsidian/);
});

test("the done list reopens a task instead of ticking it", async () => {
	const h = harness();
	await h.flow.handleTap(h.ctx as any, ["v", "done", "0"]);
	const [reopen] = h.buttons(h.edited.at(-1)!.markup);
	assert.match(reopen!, /^tk:r:personal:1:[0-9a-f]{8}:done:0$/);
	await h.flow.handleTap(h.ctx as any, reopen!.split(":").slice(1));
	assert.match(
		h.vault.content,
		/- \[ \] finish the book #type\/todo \[due:: 2026-06-14\]$/m,
	);
});

test("the morning summary is loud, dated, and its rows tick straight through", async () => {
	const today = new Date();
	const iso = (d: Date) =>
		`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	const yesterday = new Date(today.getTime() - 86_400_000);
	const h = harness(
		[
			"---",
			"updatedAt: 2026-08-01T10:00:00Z",
			"---",
			"## Things to do",
			`- [ ] Pay the invoice #type/todo [due:: ${iso(yesterday)}]`,
			`- [ ] Buy cat sand #type/todo [due:: ${iso(today)}]`,
			"- [ ] Something far off #type/todo [due:: 2099-01-01]",
			"- [x] finish the book #type/todo [due:: 2026-06-14] [completion:: 2026-06-23]",
		].join("\n"),
	);

	await h.flow.dailySummary();
	const sent = h.sent.at(-1)!;
	assert.match(sent.text, new RegExp(`🌅 Your tasks for ${iso(today)}`));
	// What's on the plate: due today plus what's still hanging over. Not the far-off one,
	// and not the finished one.
	assert.match(sent.text, /Pay the invoice/);
	assert.match(sent.text, /Buy cat sand/);
	assert.doesNotMatch(sent.text, /Something far off/);
	assert.doesNotMatch(sent.text, /finish the book/);
	assert.equal(sent.silent, false); // always notifies, never a quiet send

	// The rows are the same tickable buttons the lists use.
	const [first] = h.buttons(sent.markup);
	assert.match(first!, /^tk:k:personal:0:[0-9a-f]{8}:day:0$/);
	await h.flow.handleTap(h.ctx as any, first!.split(":").slice(1));
	assert.match(
		h.vault.content,
		/- \[x\] Pay the invoice .*\[completion:: \d{4}-\d{2}-\d{2}\]/,
	);
});

test("a day with nothing due sends nothing at all", async () => {
	const h = harness(
		[
			"## Things to do",
			"- [ ] Something far off #type/todo [due:: 2099-01-01]",
			"- [x] finish the book #type/todo [due:: 2026-06-14] [completion:: 2026-06-23]",
		].join("\n"),
	);
	await h.flow.dailySummary();
	assert.deepEqual(h.sent, []);
});

test("a summary that can't read the notes still says so, loudly", async () => {
	const h = harness();
	h.breakReads(true);
	await h.flow.dailySummary();
	assert.match(h.sent.at(-1)!.text, /Couldn't put together your task summary/);
	assert.equal(h.sent.at(-1)!.silent, false);
});

test("/taskadd reads one line through the enricher and shows the card", async () => {
	const h = harness();
	h.setExtract(async () => ({
		description: "Answer Pavlo about the Hive review",
		due: "next friday",
		type: "work",
	}));
	await (h.flow as any).quickAdd(
		h.ctx,
		"gotta answer pavlo re hive by next friday",
	);
	const d = h.drafts.get(draftId(h.drafts));
	assert.equal(d.description, "Answer Pavlo about the Hive review");
	assert.equal(d.type, "work");
	assert.match(d.due, /^\d{4}-\d{2}-\d{2}$/); // the phrase was resolved, not stored
	assert.equal(d.status, "pending");
	assert.match(h.sent.at(-1)!.text, /📝 New task/);
	assert.match(h.sent.at(-1)!.text, /Answer Pavlo about the Hive review/);
});

test("/taskadd falls back to the token-free parser when the model is down", async () => {
	const h = harness();
	h.setExtract(async () => {
		throw new Error("usage exhausted");
	});
	await (h.flow as any).quickAdd(h.ctx, "buy cat sand next week");
	const d = h.drafts.get(draftId(h.drafts));
	assert.equal(d.description, "buy cat sand");
	assert.match(d.due, /^\d{4}-\d{2}-\d{2}$/);
	assert.match(h.sent.at(-1)!.text, /📝 New task/);
});

test("/taskadd with no timing asks for the deadline straight away", async () => {
	const h = harness();
	h.setExtract(async () => ({
		description: "Renew the passport",
		type: "personal",
	}));
	await (h.flow as any).quickAdd(h.ctx, "renew the passport");
	assert.equal(h.drafts.get(draftId(h.drafts)).due, null);
	assert.match(h.sent.at(-1)!.text, /with the due date/);
});

test("a question nobody asked for never grabs the compose box", async () => {
	// The two unprompted cases: a task spotted in a jot, and a /taskadd line with no timing.
	// A force_reply here is how a message meant for the journal ends up sent as a date.
	const h = harness();
	await h.flow.suggest(
		{ description: "Call the vet", type: "personal", start: null, due: null },
		"jot12345",
		"2026-08-20",
	);
	assert.match(h.sent.at(-1)!.text, /with the due date/);
	assert.equal(h.sent.at(-1)!.markup, undefined);

	const q = harness();
	q.setExtract(async () => ({
		description: "Renew the passport",
		type: "personal",
	}));
	await (q.flow as any).quickAdd(q.ctx, "renew the passport");
	assert.match(q.sent.at(-1)!.text, /with the due date/);
	assert.equal(q.sent.at(-1)!.markup, undefined);

	// …but the same question opened from the 🏁 button does.
	const t = harness();
	await t.flow.handle(t.ctx as any, "buy milk");
	await t.flow.handleTap(t.ctx as any, ["u", draftId(t.drafts)]);
	assert.equal(t.sent.at(-1)!.markup.force_reply, true);
});

test("a task screen closes by taking itself out of the chat", async () => {
	const h = harness();
	await h.flow.handleTap(h.ctx as any, ["v", "open", "0"]);
	const labels = h
		.buttons(h.edited.at(-1)!.markup)
		.filter((d: string) => d === "tk:close");
	assert.deepEqual(labels, ["tk:close"]); // every list carries exactly one
	await h.flow.handleTap(h.ctx as any, ["close"]);
	assert.deepEqual(h.deleted, [[7, 1]]);
});

test("jot detection is on by default and the menu toggles it", async () => {
	const h = harness();
	assert.equal(
		await taskDetectionEnabled({ getSetting: async () => undefined } as any),
		true,
	);
	await h.flow.handleTap(h.ctx as any, ["det"]);
	assert.equal(h.settings.get("taskDetection"), "off");
	assert.match(h.edited.at(-1)!.text, /🗂 Tasks/);
	assert.equal(h.buttons(h.edited.at(-1)!.markup).includes("tk:det"), true);
	await h.flow.handleTap(h.ctx as any, ["det"]);
	assert.equal(h.settings.get("taskDetection"), "on");
});
