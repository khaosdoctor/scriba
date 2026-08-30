import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { ObsidianClient } from "./obsidian.ts";
import { TaskStore } from "./tasks.ts";

/**
 * The same loopback stand-in obsidian.test.ts uses: a real ObsidianClient over a real
 * socket, so the note lock, the percent-encoded paths and the read-modify-write are all
 * exercised rather than mocked. The vault is a map of path → content.
 */
type Fake = {
	vault: Map<string, string>;
	close: () => Promise<void>;
	url: string;
};
const servers: Fake[] = [];
after(async () => {
	for (const s of servers) await s.close();
});

const WORK_PATH = "notes/tracking notes/What's going on at work.md";
const PERSONAL_PATH = "notes/tracking notes/dashboards/Todos.md";

const WORK_NOTE = [
	"---",
	"title: What's going on",
	"updatedAt: 2026-08-25T23:20:33Z",
	"---",
	"# What's going on",
	"",
	"## Projects and initiatives",
	"- [ ] not a task of ours",
	"",
	"## Other Tasks",
	"- [ ] Review the RFC #type/todo/work [start:: 2026-08-20] [due:: 2026-08-22]",
	"- [x] Finish the RFC bot #type/todo/work [start:: 2026-07-13] [due:: 2026-07-09] [completion:: 2026-08-06]",
	"",
	"## Recent catch-ups",
	"",
].join("\n");

const PERSONAL_NOTE = [
	"---",
	"aliases: [To-dos]",
	"updatedAt: 2026-08-01T10:00:00Z",
	"---",
	"# Todos",
	"",
	"## Things to do",
	"- [ ] Buy cat sand #type/todo [start:: 2026-08-28] [due:: 2026-09-02]",
	"",
].join("\n");

async function store() {
	const vault = new Map<string, string>([
		[WORK_PATH, WORK_NOTE],
		[PERSONAL_PATH, PERSONAL_NOTE],
	]);
	const server: Server = createServer(async (req, res) => {
		const path = decodeURIComponent((req.url ?? "").replace(/^\/vault\//, ""));
		if (req.method === "GET") {
			const body = vault.get(path);
			if (body === undefined) return void res.writeHead(404).end("not found");
			return void res.writeHead(200).end(body);
		}
		if (req.method === "PUT") {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			vault.set(path, Buffer.concat(chunks).toString("utf8"));
			return void res.writeHead(204).end();
		}
		res.writeHead(500).end("boom");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	const fake: Fake = {
		vault,
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((r) => void server.close(() => r())),
	};
	servers.push(fake);
	const obsidian = new ObsidianClient({
		url: fake.url,
		key: "hunter2",
		dailyDir: "notes/daily notes",
		dailyTemplate: "internal/templates/Daily Note",
		journalHeading: "Journal",
		habitsHeading: "Habits",
		assetsDir: "internal/assets/journal",
		insecureTls: false,
	});
	return {
		vault,
		tasks: new TaskStore(obsidian, {
			work: {
				path: WORK_PATH,
				heading: "Other Tasks",
				tag: "#type/todo/work",
				insert: "top",
			},
			personal: {
				path: PERSONAL_PATH,
				heading: "Things to do",
				tag: "#type/todo",
				insert: "bottom",
			},
		}),
	};
}

test("list reads both notes and only their task sections", async () => {
	const { tasks } = await store();
	const all = await tasks.list();
	assert.deepEqual(
		all.map((t) => t.text),
		["Review the RFC", "Finish the RFC bot", "Buy cat sand"],
	);
	assert.deepEqual(
		all.map((t) => t.type),
		["work", "work", "personal"],
	);
	assert.equal((await tasks.list("personal")).length, 1);
});

test("a work task goes to the top of its section, a personal one to the bottom", async () => {
	const { tasks, vault } = await store();
	await tasks.add(
		{
			description: "Answer Pavlo",
			type: "work",
			start: null,
			due: "2026-09-04",
		},
		"2026-08-29",
	);
	const work = vault.get(WORK_PATH)!.split("\n");
	assert.equal(
		work[work.indexOf("## Other Tasks") + 1],
		"- [ ] Answer Pavlo (from [[2026-08-29]]) #type/todo/work [start:: 2026-09-04] [due:: 2026-09-04]",
	);
	// The other sections are untouched.
	assert.match(
		vault.get(WORK_PATH)!,
		/## Projects and initiatives\n- \[ \] not a task of ours/,
	);

	await tasks.add(
		{
			description: "Buy milk",
			type: "personal",
			start: "2026-08-30",
			due: "2026-09-01",
		},
		"2026-08-29",
	);
	const personal = await tasks.list("personal");
	assert.deepEqual(
		personal.map((t) => t.text),
		["Buy cat sand", "Buy milk (from [[2026-08-29]])"],
	);
});

test("creating a task bumps the note's updatedAt", async () => {
	const { tasks, vault } = await store();
	await tasks.add(
		{
			description: "Buy milk",
			type: "personal",
			start: null,
			due: "2026-09-01",
		},
		"2026-08-29",
	);
	assert.doesNotMatch(
		vault.get(PERSONAL_PATH)!,
		/updatedAt: 2026-08-01T10:00:00Z/,
	);
	assert.match(
		vault.get(PERSONAL_PATH)!,
		/updatedAt: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/,
	);
});

test("ticking and unticking a task round-trips through the note", async () => {
	const { tasks, vault } = await store();
	const before = (await tasks.list("work"))[0]!;
	const done = await tasks.setDone("work", 0, before.fingerprint, true);
	assert.equal(done?.state, "done");
	assert.match(
		vault.get(WORK_PATH)!,
		/- \[x\] Review the RFC .*\[completion:: \d{4}-\d{2}-\d{2}\]/,
	);

	const again = (await tasks.list("work"))[0]!;
	const open = await tasks.setDone("work", 0, again.fingerprint, false);
	assert.equal(open?.state, "open");
	assert.equal(
		vault
			.get(WORK_PATH)!
			.split("\n")
			.find((l) => l.includes("Review the RFC")),
		"- [ ] Review the RFC #type/todo/work [start:: 2026-08-20] [due:: 2026-08-22]",
	);
});

test("a tap whose note changed underneath is refused, not applied to the wrong row", async () => {
	const { tasks, vault } = await store();
	const stale = (await tasks.list("work"))[0]!;
	// Someone reorders the section in Obsidian: index 0 is now a different task.
	vault.set(
		WORK_PATH,
		vault
			.get(WORK_PATH)!
			.replace(
				"- [ ] Review the RFC #type/todo/work [start:: 2026-08-20] [due:: 2026-08-22]\n",
				"",
			)
			.replace(
				"## Other Tasks\n",
				"## Other Tasks\n- [ ] Something else entirely #type/todo/work [due:: 2026-08-30]\n",
			),
	);
	assert.equal(await tasks.setDone("work", 0, stale.fingerprint, true), null);
	assert.match(vault.get(WORK_PATH)!, /- \[ \] Something else entirely/); // untouched
	assert.equal(await tasks.setDone("work", 99, stale.fingerprint, true), null);
});
