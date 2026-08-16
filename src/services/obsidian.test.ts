import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { ObsidianClient, type ObsidianConfig } from "./obsidian.ts";

/**
 * A stand-in for Obsidian's Local REST API, served on loopback so the client's real fetch,
 * headers and status handling are exercised rather than mocked out. The vault is a map of
 * path → content; every request is recorded so a test can assert what reached the network
 * (which, for the locking and dedupe below, is the whole point).
 */
type Fake = {
	url: string;
	vault: Map<string, string>;
	seen: { method: string; path: string; auth?: string }[];
	/** Held back until a test releases it, to force overlap. */
	stall: (path: string) => () => void;
	/** Answer one `"<METHOD> <path>"` with a status instead of serving it. */
	fail: (key: string, status: number) => () => void;
	close: () => Promise<void>;
};

async function serve(): Promise<Fake> {
	const vault = new Map<string, string>();
	const seen: Fake["seen"] = [];
	const gates = new Map<string, Promise<void>>();
	const broken = new Map<string, number>();
	const server: Server = createServer(async (req, res) => {
		// The client percent-encodes each segment; decode back to the vault-relative path.
		const path = decodeURIComponent((req.url ?? "").replace(/^\/vault\//, ""));
		seen.push({
			method: req.method ?? "",
			path,
			auth: req.headers.authorization,
		});
		const key = `${req.method} ${path}`;
		await gates.get(key);
		const status = broken.get(key);
		if (status !== undefined) return void res.writeHead(status).end("nope");
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
		if (req.method === "DELETE") {
			if (!vault.delete(path)) return void res.writeHead(404).end();
			return void res.writeHead(204).end();
		}
		res.writeHead(500).end("boom");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		vault,
		seen,
		stall: (key: string) => {
			let release = () => {};
			gates.set(
				key,
				new Promise<void>((r) => {
					release = r;
				}),
			);
			return () => {
				gates.delete(key);
				release();
			};
		},
		fail: (key: string, status: number) => {
			broken.set(key, status);
			return () => void broken.delete(key);
		},
		close: () => new Promise<void>((r) => void server.close(() => r())),
	};
}

const servers: Fake[] = [];
after(async () => {
	for (const s of servers) await s.close();
});

async function client(over: Partial<ObsidianConfig> = {}) {
	const fake = await serve();
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
		...over,
	});
	return { obsidian, fake };
}

const counted = (fake: Fake, method: string, path?: string) =>
	fake.seen.filter((r) => r.method === method && (!path || r.path === path))
		.length;

test("paths with spaces survive the round trip, and every call carries the key", async () => {
	const { obsidian, fake } = await client();
	assert.equal(
		obsidian.dailyPath("2026-08-16"),
		"notes/daily notes/2026-08-16.md",
	);
	fake.vault.set("notes/daily notes/2026-08-16.md", "# hi");

	assert.equal(
		await obsidian.readNote("notes/daily notes/2026-08-16.md"),
		"# hi",
	);
	// A raw space in a URL is not a valid request; each segment is encoded, slashes aren't.
	assert.equal(fake.seen.at(-1)?.path, "notes/daily notes/2026-08-16.md");
	assert.equal(fake.seen.at(-1)?.auth, "Bearer hunter2");
});

test("a missing note is an error to read but not to delete", async () => {
	const { obsidian } = await client();
	await assert.rejects(() => obsidian.readNote("nope.md"), /note not found/);
	// Deleting something already gone is the outcome the caller wanted.
	await obsidian.deleteNote("nope.md");
});

test("readDailyNote answers null for a day that was never journaled", async () => {
	const { obsidian, fake } = await client();
	assert.equal(await obsidian.readDailyNote("2026-08-16"), null);
	fake.vault.set("notes/daily notes/2026-08-16.md", "# day");
	assert.deepEqual(await obsidian.readDailyNote("2026-08-16"), {
		path: "notes/daily notes/2026-08-16.md",
		content: "# day",
	});
});

test("ensureDailyNote fills {{date}} from the template, and leaves an existing note alone", async () => {
	const { obsidian, fake } = await client();
	fake.vault.set(
		"internal/templates/Daily Note.md",
		"# {{date}}\n\n## Journal\n- \n",
	);

	const path = await obsidian.ensureDailyNote("2026-08-16");
	assert.equal(path, "notes/daily notes/2026-08-16.md");
	assert.equal(fake.vault.get(path), "# 2026-08-16\n\n## Journal\n- \n");

	// Second call: the note exists, so nothing is written over it.
	const puts = counted(fake, "PUT");
	await obsidian.ensureDailyNote("2026-08-16");
	assert.equal(counted(fake, "PUT"), puts);
});

test("a vault with no template still gets a note with a Journal heading", async () => {
	const { obsidian, fake } = await client();
	await obsidian.ensureDailyNote("2026-08-16");
	assert.equal(
		fake.vault.get("notes/daily notes/2026-08-16.md"),
		"## Journal\n",
	);
});

test("two intakes on the first jot of the day create the note once", async () => {
	const { obsidian, fake } = await client();
	// Hold the existence check so both callers are inside ensureDailyNote at once — the
	// race the in-flight map exists to stop. Without it both 404, both PUT the blank
	// template, and the second erases the first's placeholder line.
	const release = fake.stall("GET notes/daily notes/2026-08-16.md");
	const both = Promise.all([
		obsidian.ensureDailyNote("2026-08-16"),
		obsidian.ensureDailyNote("2026-08-16"),
	]);
	release();
	assert.deepEqual(await both, [
		"notes/daily notes/2026-08-16.md",
		"notes/daily notes/2026-08-16.md",
	]);
	assert.equal(counted(fake, "PUT", "notes/daily notes/2026-08-16.md"), 1);
});

test("a failed creation doesn't poison the next attempt", async () => {
	const { obsidian, fake } = await client();
	const path = "notes/daily notes/2026-08-16.md";
	// The in-flight entry has to be cleared on failure too, or the day's first jot fails
	// and every jot after it rides the same rejected promise — the day never recovers.
	const mend = fake.fail(`GET ${path}`, 500);
	await assert.rejects(() => obsidian.ensureDailyNote("2026-08-16"), /500/);
	mend();
	assert.equal(await obsidian.ensureDailyNote("2026-08-16"), path);
	assert.ok(fake.vault.has(path));
});

test("withNoteLock serializes read-modify-write, so no update is clobbered", async () => {
	const { obsidian, fake } = await client();
	const path = "notes/a.md";
	fake.vault.set(path, "start");

	// Both stacks read-modify-write the same note. Unserialized they'd both read "start"
	// and the later PUT would drop the earlier's append.
	const append = (suffix: string) =>
		obsidian.withNoteLock(path, async () => {
			const note = await obsidian.readNote(path);
			await new Promise((r) => setTimeout(r, 10)); // widen the window
			await obsidian.writeNote(path, `${note}+${suffix}`);
		});
	await Promise.all([append("one"), append("two")]);
	assert.equal(fake.vault.get(path), "start+one+two");
});

test("a lock holder that throws surfaces the error and frees the path", async () => {
	const { obsidian, fake } = await client();
	fake.vault.set("notes/a.md", "start");
	await assert.rejects(
		() =>
			obsidian.withNoteLock("notes/a.md", async () => {
				throw new Error("write failed");
			}),
		/write failed/,
	);
	// The chain stores a caught tail, so one failure can't wedge the note forever.
	const out = await obsidian.withNoteLock("notes/a.md", async () =>
		obsidian.readNote("notes/a.md"),
	);
	assert.equal(out, "start");
});

test("appendJournalLine puts the bullet under the heading, not below a blank line", async () => {
	const { obsidian, fake } = await client();
	const path = "notes/daily notes/2026-08-16.md";
	fake.vault.set(path, "# 2026-08-16\n\n## Journal\n- \n");
	await obsidian.appendJournalLine(
		"2026-08-16",
		"- _10:00:00 ::_ hi ^aaaaaaaa",
	);
	assert.equal(
		fake.vault.get(path),
		"# 2026-08-16\n\n## Journal\n- _10:00:00 ::_ hi ^aaaaaaaa\n",
	);
});

test("setDailyRating creates the day's note when it was never journaled", async () => {
	const { obsidian, fake } = await client();
	await obsidian.setDailyRating("2026-08-16", 8);
	assert.match(
		fake.vault.get("notes/daily notes/2026-08-16.md") ?? "",
		/^---\noverallRating: 8\n---/,
	);
});

test("saveAsset writes under the assets dir and answers with the vault path", async () => {
	const { obsidian, fake } = await client();
	const path = await obsidian.saveAsset(
		"2026-08-16 photo.jpg",
		new Uint8Array([1, 2, 3]),
		"image/jpeg",
	);
	assert.equal(path, "internal/assets/journal/2026-08-16 photo.jpg");
	assert.ok(fake.vault.has(path));
});

test("a server error is raised rather than mistaken for a missing note", async () => {
	const { obsidian, fake } = await client();
	fake.vault.set("notes/a.md", "ok");
	// 404 means "no such note"; anything else means the API is unwell. Treating a 500 as
	// an empty note would write over a note the client simply failed to read.
	const mend = fake.fail("GET notes/a.md", 500);
	await assert.rejects(
		() => obsidian.readNote("notes/a.md"),
		/obsidian GET .*500/,
	);
	mend();
	assert.equal(await obsidian.readNote("notes/a.md"), "ok");
});

test("a rejected write is raised, not swallowed", async () => {
	const { obsidian, fake } = await client();
	const mend = fake.fail("PUT notes/a.md", 403);
	await assert.rejects(
		() => obsidian.writeNote("notes/a.md", "x"),
		/obsidian PUT notes\/a.md: 403/,
	);
	mend();
	await obsidian.writeNote("notes/a.md", "x");
	assert.equal(fake.vault.get("notes/a.md"), "x");
});

test("deleteNote raises on a real failure but tolerates a 404", async () => {
	const { obsidian, fake } = await client();
	fake.vault.set("notes/a.md", "x");
	const mend = fake.fail("DELETE notes/a.md", 500);
	await assert.rejects(() => obsidian.deleteNote("notes/a.md"), /500/);
	mend();
	await obsidian.deleteNote("notes/a.md");
	assert.equal(fake.vault.has("notes/a.md"), false);
});
