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

type Sent = { chat: number; text: string; markup?: any };
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
	let nextId = 100;
	const bot = {
		api: {
			sendMessage: async (chat: number, text: string, opts?: any) => {
				sent.push({ chat, text, markup: opts?.reply_markup });
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
		getSetting: async (k: string) => settings.get(k),
		setSetting: async (k: string, v: string) => void settings.set(k, v),
	};

	// A minimal Obsidian stand-in: one note in memory, read and written whole.
	const vault = { content: note };
	const obsidian = {
		readNote: async () => vault.content,
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
	const flow = new TasksFlow(bot as any, repo as any, store, () => false);

	const ctx = {
		chat: { id: 7 },
		reply: async (text: string, opts?: any) => {
			sent.push({ chat: 7, text, markup: opts?.reply_markup });
			return { message_id: nextId++, chat: { id: 7 } };
		},
		answerCallbackQuery: async (o?: any) => void answered.push(o?.text ?? ""),
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
		drafts,
		vault,
		ctx,
		buttons,
		settings,
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
	assert.match(h.sent.at(-1)!.text, /When is it due\?.*\(tk:u:/s);
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

	await h.flow.handleReply(
		{ ...h.ctx, message: { text: "2026-09-15" } } as any,
		prompt,
	);
	assert.equal(h.drafts.get(id).due, "2026-09-15");

	await h.flow.handleReply(
		{ ...h.ctx, message: { text: "banana" } } as any,
		prompt,
	);
	assert.equal(h.drafts.get(id).due, "2026-09-15"); // unchanged
	assert.match(h.sent.at(-1)!.text, /couldn't read that as a date/);

	// The deadline is the mandatory one, so it can't be cleared.
	await h.flow.handleReply(
		{ ...h.ctx, message: { text: "none" } } as any,
		prompt,
	);
	assert.equal(h.drafts.get(id).due, "2026-09-15");
	assert.match(h.sent.at(-1)!.text, /needs a deadline/);
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
	assert.match(h.sent[1]!.text, /When is it due\?/);

	await h.flow.handleTap(h.ctx as any, ["x", d.id]);
	assert.equal(h.drafts.get(d.id).status, "dismissed");
	assert.match(h.edited.at(-1)!.text, /Not a task/);
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
